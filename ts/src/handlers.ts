import { getContractAddressesForChainOrThrow } from '@0x/contract-addresses';
import { ContractWrappers } from '@0x/contract-wrappers';
import { orderHashUtils, transactionHashUtils } from '@0x/contracts-test-utils';
import { orderCalculationUtils, ZeroExTransaction } from '@0x/order-utils';
import { Web3ProviderEngine } from '@0x/subproviders';
import { Order, SignatureType, SignedOrder } from '@0x/types';
import { BigNumber, DecodedCalldata } from '@0x/utils';
import * as ethUtil from 'ethereumjs-util';
import * as sigUtil from 'eth-sig-util';
import * as express from 'express';
import * as HttpStatus from 'http-status-codes';
import * as _ from 'lodash';

import { ValidationError, ValidationErrorCodes } from './errors';
import { orderModel } from './models/order_model';
import { transactionModel } from './models/transaction_model';
import * as requestTransactionSchema from './schemas/request_transaction_schema.json';
import * as softCancelsSchema from './schemas/soft_cancels_schema.json';
import {
    BroadcastCallback,
    ChainIdToContractWrappers,
    ChainIdToProvider,
    Configs,
    EventTypes,
    ExchangeMethods,
    OrderAndTraderInfo,
    RequestTransactionResponse,
    Response,
    TraderInfo,
} from './types';
import { utils } from './utils';


const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';

export class Handlers {
    private readonly _broadcastCallback: BroadcastCallback;
    private readonly _chainIdToContractWrappers: ChainIdToContractWrappers;
    private readonly _configs: Configs;
    private _cordinatorAddress: string | undefined;

    constructor(chainIdToProvider: ChainIdToProvider, configs: Configs, broadcastCallback: BroadcastCallback) {
        this._broadcastCallback = broadcastCallback;
        this._configs = configs;
        this._chainIdToContractWrappers = {};
        _.each(chainIdToProvider, (provider: Web3ProviderEngine, chainIdStr: string) => {
            const chainId = _.parseInt(chainIdStr);
            const contractAddresses = configs.CHAIN_ID_TO_CONTRACT_ADDRESSES
                ? configs.CHAIN_ID_TO_CONTRACT_ADDRESSES[chainId]
                : undefined;
            this._cordinatorAddress = configs.CHAIN_ID_TO_SETTINGS[chainId].COORDINATOR_CONTRACT_ADDRESS;
            const contractWrappers = new ContractWrappers(provider, {
                chainId,
                contractAddresses,
            });
            this._chainIdToContractWrappers[chainId] = contractWrappers;
        });
    }

    private static _calculateRemainingFillableTakerAssetAmount(
        signedOrder: SignedOrder,
        orderAndTraderInfo: OrderAndTraderInfo,
    ): BigNumber {
        const orderInfo = orderAndTraderInfo.orderInfo;
        const traderInfo = orderAndTraderInfo.traderInfo;

        const minSet = [];

        // Calculate min of balance & allowance of taker's takerAsset
        if (signedOrder.takerAddress !== NULL_ADDRESS) {
            const maxTakerAssetFillAmountGivenTakerConstraints = BigNumber.min(
                traderInfo.takerBalance,
                traderInfo.takerAllowance,
            );
            minSet.push(maxTakerAssetFillAmountGivenTakerConstraints);
        }

        // Calculate min of balance & allowance of maker's makerAsset -> translate into takerAsset amount
        const maxMakerAssetFillAmount = BigNumber.min(traderInfo.makerBalance, traderInfo.makerAllowance);
        const maxTakerAssetFillAmountGivenMakerConstraints = orderCalculationUtils.getTakerFillAmount(
            signedOrder,
            maxMakerAssetFillAmount,
        );
        minSet.push(maxTakerAssetFillAmountGivenMakerConstraints);

        // Calculate min of balance & allowance of taker's Fee -> translate into takerAsset amount
        if (!signedOrder.takerFee.eq(0)) {
            const takerFeeAvailable = BigNumber.min(traderInfo.takerFeeBalance, traderInfo.takerFeeAllowance);
            const maxTakerAssetFillAmountGivenTakerFeeConstraints = takerFeeAvailable
                .multipliedBy(signedOrder.takerAssetAmount)
                .div(signedOrder.takerFee)
                .integerValue(BigNumber.ROUND_FLOOR);
            minSet.push(maxTakerAssetFillAmountGivenTakerFeeConstraints);
        }

        // Calculate min of balance & allowance of maker's Fee -> translate into takerAsset amount
        if (!signedOrder.makerFee.eq(0)) {
            const makerFeeAvailable = BigNumber.min(traderInfo.makerFeeBalance, traderInfo.makerFeeAllowance);
            const maxTakerAssetFillAmountGivenMakerFeeConstraints = makerFeeAvailable
                .multipliedBy(signedOrder.takerAssetAmount)
                .div(signedOrder.makerFee)
                .integerValue(BigNumber.ROUND_FLOOR);
            minSet.push(maxTakerAssetFillAmountGivenMakerFeeConstraints);
        }

        const remainingTakerAssetFillAmount = signedOrder.takerAssetAmount.minus(orderInfo.orderTakerAssetFilledAmount);
        minSet.push(remainingTakerAssetFillAmount);

        const maxTakerAssetFillAmount = BigNumber.min(...minSet);
        return maxTakerAssetFillAmount;
    }

    private static _getOrdersFromDecodedCalldata(decodedCalldata: DecodedCalldata, chainId: number): Order[] {
        const contractAddresses = getContractAddressesForChainOrThrow(chainId);

        switch (decodedCalldata.functionName) {
            case ExchangeMethods.FillOrder:
            case ExchangeMethods.FillOrKillOrder:
            case ExchangeMethods.CancelOrder: {
                const orderWithoutExchangeAddress = decodedCalldata.functionArguments.order;
                const order = {
                    ...orderWithoutExchangeAddress,
                    exchangeAddress: contractAddresses.exchange,
                    chainId,
                };
                return [order];
            }

            case ExchangeMethods.BatchFillOrders:
            case ExchangeMethods.BatchFillOrKillOrders:
            case ExchangeMethods.BatchFillOrdersNoThrow:
            case ExchangeMethods.MarketSellOrdersFillOrKill:
            case ExchangeMethods.MarketSellOrdersNoThrow:
            case ExchangeMethods.MarketBuyOrdersFillOrKill:
            case ExchangeMethods.MarketBuyOrdersNoThrow:
            case ExchangeMethods.BatchCancelOrders: {
                const ordersWithoutExchangeAddress = decodedCalldata.functionArguments.orders;
                const orders = _.map(ordersWithoutExchangeAddress, orderWithoutExchangeAddress => {
                    return {
                        ...orderWithoutExchangeAddress,
                        exchangeAddress: contractAddresses.exchange,
                        chainId,
                    };
                });
                return orders;
            }

            default:
                throw utils.getInvalidFunctionCallError(decodedCalldata.functionName);
        }
    }

    private static async _validateOrdersAsync(
        signedTransaction: ZeroExTransaction,
        coordinatorOrders: Order[],
        takerAssetFillAmounts: BigNumber[],
    ): Promise<string[]> {
        // Find all soft-cancelled orders
        const softCancelledOrderHashes = await orderModel.findSoftCancelledOrdersAsync(coordinatorOrders);

        // Takers can only request to fill an order entirely once. If they do multiple
        // partial fills, we keep track and make sure they have a sufficient partial fill
        // amount left for this request to get approved.

        // Verify the fill amounts for all orders that have not been soft-cancelled
        const availableCoordinatorOrders = _.filter(
            coordinatorOrders,
            o => !_.includes(softCancelledOrderHashes, orderHashUtils.getOrderHashHex(o)),
        );

        // Core assumption. If signature type is `Wallet`, then takerAddress = walletContractAddress.
        const takerAddress = signedTransaction.signerAddress;
        const orderHashToFillAmount = await transactionModel.getOrderHashToFillAmountRequestedAsync(
            availableCoordinatorOrders,
            takerAddress,
        );
        const orderHashesWithInsufficientFillAmounts = [];
        const redundantOrders = [];
        for (let i = 0; i < availableCoordinatorOrders.length; i++) {
            const coordinatorOrder = availableCoordinatorOrders[i];
            const orderHash = orderModel.getHash(coordinatorOrder);
            const takerAssetFillAmount = takerAssetFillAmounts[i];
            if (takerAssetFillAmount.eq(new BigNumber(0))) {
                redundantOrders.push(orderHash);
                continue;
            }
            const previouslyRequestedFillAmount = orderHashToFillAmount[orderHash] || new BigNumber(0);
            const totalRequestedFillAmount = previouslyRequestedFillAmount.plus(takerAssetFillAmount);
            if (totalRequestedFillAmount.gt(coordinatorOrder.takerAssetAmount)) {
                orderHashesWithInsufficientFillAmounts.push(orderHash);
            }

        }

        const expiredOrders = [];
        for (let i = 0; i < availableCoordinatorOrders.length; i++) {
            const coordinatorOrder = availableCoordinatorOrders[i];
            const orderHash = orderModel.getHash(coordinatorOrder);
            const ONE_SECOND_MS = 1000;
            const currentTime = new BigNumber(Date.now()).div(ONE_SECOND_MS).dp(0, 6);
            const isExpired = coordinatorOrder.expirationTimeSeconds.isLessThan(currentTime);
            if (isExpired) {
                expiredOrders.push(orderHash);
            }
        }


        return [...softCancelledOrderHashes, ...orderHashesWithInsufficientFillAmounts, ...expiredOrders, ...redundantOrders];
    }

    public async postRequestTransactionAsync(req: express.Request, res: express.Response): Promise<void> {
        // 1. Validate request schema
        utils.validateSchema(req.body, requestTransactionSchema);
        const txOrigin = req.body.txOrigin;
        const chainId = req.chainId;

        // 2. Decode the supplied transaction data
        const signedTransaction: ZeroExTransaction = {
            ...req.body.signedTransaction,
            salt: new BigNumber(req.body.signedTransaction.salt),
            expirationTimeSeconds: new BigNumber(req.body.signedTransaction.expirationTimeSeconds),
        };
        let decodedCalldata: DecodedCalldata;
        try {
            const contractWrappers = this._chainIdToContractWrappers[chainId];
            decodedCalldata = contractWrappers
                .getAbiDecoder()
                .decodeCalldataOrThrow(signedTransaction.data, 'Exchange');
        } catch (err) {
            throw new ValidationError([
                {
                    field: 'signedTransaction.data',
                    code: ValidationErrorCodes.ZeroExTransactionDecodingFailed,
                    reason: '0x transaction data decoding failed',
                },
            ]);
        }

        // 3. Check if at least one order in calldata has the Coordinator's feeRecipientAddress
        // let orders: Order[] = [];
        // orders = Handlers._getOrdersFromDecodedCalldata(decodedCalldata, chainId);
        const coordinatorOrders = Handlers._getOrdersFromDecodedCalldata(decodedCalldata, chainId);
        // const coordinatorOrders = _.filter(orders, order => {
        //     const coordinatorFeeRecipients = this._configs.CHAIN_ID_TO_SETTINGS[chainId].FEE_RECIPIENTS;
        //     const coordinatorFeeRecipientAddresses = _.map(
        //         coordinatorFeeRecipients,
        //         feeRecipient => feeRecipient.ADDRESS,
        //     );
        //     return _.includes(coordinatorFeeRecipientAddresses, order.feeRecipientAddress);
        // });
        if (_.isEmpty(coordinatorOrders)) {
            throw new ValidationError([
                {
                    field: 'signedTransaction.data',
                    code: ValidationErrorCodes.NoCoordinatorOrdersIncluded,
                    reason:
                        '0x transaction data does not include any orders involving this coordinators feeRecipientAddresses',
                },
            ]);
        }

        // 4. Enforce that a 0x transaction hasn't been used before. This prevents someone from requesting
        // the same transaction with a different `txOrigin` in an attempt to fill the order through an
        // alternative tx.origin entry-point.
        const transactionHash = transactionHashUtils.getTransactionHashHex(signedTransaction);
        const transactionIfExists = await transactionModel.findByHashAsync(transactionHash);
        if (transactionIfExists !== undefined) {
            throw new ValidationError([
                {
                    field: 'signedTransaction',
                    code: ValidationErrorCodes.TransactionAlreadyUsed,
                    reason: `A transaction can only be approved once. To request approval to perform the same actions, generate and sign an identical transaction with a different salt value.`,
                },
            ]);
        }

        // Since we are dropping the tx signature we won't be doing any validation
        // 5. Validate the 0x transaction signature
        // const isValidSignature = await this._chainIdToContractWrappers[chainId].exchange
        //     .isValidHashSignature(transactionHash, signedTransaction.signerAddress, signedTransaction.signature)
        //     .callAsync();
        // if (!isValidSignature) {
        //     throw new ValidationError([
        //         {
        //             field: 'signedTransaction.signature',
        //             code: ValidationErrorCodes.InvalidZeroExTransactionSignature,
        //             reason: '0x transaction signature is invalid',
        //         },
        //     ]);
        // }

        // 6. Handle the request
        switch (decodedCalldata.functionName) {
            case ExchangeMethods.FillOrder:
            case ExchangeMethods.FillOrKillOrder:
            case ExchangeMethods.BatchFillOrders:
            case ExchangeMethods.BatchFillOrKillOrders:
            case ExchangeMethods.BatchFillOrdersNoThrow:
            case ExchangeMethods.MarketSellOrdersFillOrKill:
            case ExchangeMethods.MarketSellOrdersNoThrow:
            case ExchangeMethods.MarketBuyOrdersFillOrKill:
            case ExchangeMethods.MarketBuyOrdersNoThrow: {
                const takerAddress = signedTransaction.signerAddress;
                const takerAssetFillAmounts = await this._getTakerAssetFillAmountsFromDecodedCalldataAsync(
                    decodedCalldata,
                    takerAddress,
                    chainId,
                );
                const response = await this._handleFillsAsync(
                    coordinatorOrders,
                    txOrigin,
                    signedTransaction,
                    takerAssetFillAmounts,
                    chainId,
                );
                res.status(response.status).send(response.body);
                // After responding to taker's request, we broadcast the fill acceptance to all WS connections
                const fillRequestAcceptedEvent = {
                    type: EventTypes.FillRequestAccepted,
                    data: {
                        approvalHash: response.body.approvalHash,
                        functionName: decodedCalldata.functionName,
                        // orders: coordinatorOrders,
                        order: coordinatorOrders[0],
                        takerAssetFillAmounts,
                        approvedOrderHashes: response.body.approvedOrderHashes,
                        // txOrigin,
                        // signedTransaction,
                        // approvalSignatures: response.body.signatures,
                        approvalExpirationTimeSeconds: response.body.expirationTimeSeconds,
                    },
                };
                this._broadcastCallback(fillRequestAcceptedEvent as any, chainId);
                return;
            }

            case ExchangeMethods.CancelOrder:
            case ExchangeMethods.BatchCancelOrders: {
                const response = await this._handleCancelsAsync(
                    coordinatorOrders,
                    signedTransaction,
                    chainId,
                    // txOrigin,
                );
                res.status(response.status).send(response.body);
                return;
            }

            default:
                throw utils.getInvalidFunctionCallError(decodedCalldata.functionName);
        }
    }

    // tslint:disable-next-line:prefer-function-over-method
    public async postSoftCancelsAsync(req: express.Request, res: express.Response): Promise<void> {
        utils.validateSchema(req.body, softCancelsSchema);

        const softCancelsFound = await orderModel.findSoftCancelledOrdersByHashAsync(req.body.orderHashes);
        res.status(HttpStatus.OK).send({
            orderHashes: softCancelsFound,
        });
    }

    private async _getTakerAssetFillAmountsFromDecodedCalldataAsync(
        decodedCalldata: DecodedCalldata,
        takerAddress: string,
        chainId: number,
    ): Promise<BigNumber[]> {
        let takerAssetFillAmounts: BigNumber[] = [];
        switch (decodedCalldata.functionName) {
            case ExchangeMethods.FillOrder:
            case ExchangeMethods.FillOrKillOrder:
                takerAssetFillAmounts.push(decodedCalldata.functionArguments.takerAssetFillAmount);
                break;

            case ExchangeMethods.BatchFillOrders:
            case ExchangeMethods.BatchFillOrKillOrders:
            case ExchangeMethods.BatchFillOrdersNoThrow:
                takerAssetFillAmounts = decodedCalldata.functionArguments.takerAssetFillAmounts;
                break;

            case ExchangeMethods.MarketSellOrdersFillOrKill:
            case ExchangeMethods.MarketSellOrdersNoThrow: {
                takerAssetFillAmounts = await this._extractTakerAssetFillAmountsFromMarketSellOrdersAsync(
                    decodedCalldata,
                    takerAddress,
                    chainId,
                );
                break;
            }

            case ExchangeMethods.MarketBuyOrdersFillOrKill:
            case ExchangeMethods.MarketBuyOrdersNoThrow: {
                takerAssetFillAmounts = await this._extractTakerAssetFillAmountsFromMarketBuyOrdersAsync(
                    decodedCalldata,
                    takerAddress,
                    chainId,
                );
                break;
            }

            default:
                throw utils.getInvalidFunctionCallError(decodedCalldata.functionName);
        }
        return takerAssetFillAmounts;
    }

    private async _extractTakerAssetFillAmountsFromMarketSellOrdersAsync(
        decodedCalldata: DecodedCalldata,
        takerAddress: string,
        chainId: number,
    ): Promise<BigNumber[]> {
        const takerAssetFillAmounts: BigNumber[] = [];
        const contractAddresses = getContractAddressesForChainOrThrow(chainId);
        const signedOrders = utils.getSignedOrdersFromOrderWithoutExchangeAddresses(
            decodedCalldata.functionArguments.orders,
            decodedCalldata.functionArguments.signatures,
            contractAddresses.exchange,
        );
        const batchOrderAndTraderInfo = await this._getBatchOrderAndTraderInfoAsync(
            signedOrders,
            takerAddress,
            chainId,
        );
        let totalTakerAssetAmount: BigNumber = decodedCalldata.functionArguments.takerAssetFillAmount;
        _.each(batchOrderAndTraderInfo, (orderAndTraderInfo: OrderAndTraderInfo, i: number) => {
            const remainingFillableTakerAssetAmount = Handlers._calculateRemainingFillableTakerAssetAmount(
                signedOrders[i],
                orderAndTraderInfo,
            );
            const takerAssetFillAmount = totalTakerAssetAmount.isLessThan(remainingFillableTakerAssetAmount)
                ? totalTakerAssetAmount
                : remainingFillableTakerAssetAmount;
            totalTakerAssetAmount = totalTakerAssetAmount.minus(takerAssetFillAmount);
            takerAssetFillAmounts.push(takerAssetFillAmount);
        });

        return takerAssetFillAmounts;
    }

    private async _extractTakerAssetFillAmountsFromMarketBuyOrdersAsync(
        decodedCalldata: DecodedCalldata,
        takerAddress: string,
        chainId: number,
    ): Promise<BigNumber[]> {
        const takerAssetFillAmounts: BigNumber[] = [];
        const contractAddresses = getContractAddressesForChainOrThrow(chainId);
        const signedOrders = utils.getSignedOrdersFromOrderWithoutExchangeAddresses(
            decodedCalldata.functionArguments.orders,
            decodedCalldata.functionArguments.signatures,
            contractAddresses.exchange,
        );
        const batchOrderAndTraderInfo = await this._getBatchOrderAndTraderInfoAsync(
            signedOrders,
            takerAddress,
            chainId,
        );
        let totalMakerAssetAmount: BigNumber = decodedCalldata.functionArguments.makerAssetFillAmount;
        _.each(batchOrderAndTraderInfo, (orderAndTraderInfo: OrderAndTraderInfo, i: number) => {
            const signedOrder = signedOrders[i];
            const remainingFillableTakerAssetAmount = Handlers._calculateRemainingFillableTakerAssetAmount(
                signedOrder,
                orderAndTraderInfo,
            );
            const totalTakerAssetAmountAtOrderExchangeRate = orderCalculationUtils.getTakerFillAmount(
                signedOrder,
                totalMakerAssetAmount,
            );
            const takerAssetFillAmount = totalTakerAssetAmountAtOrderExchangeRate.isLessThan(
                remainingFillableTakerAssetAmount,
            )
                ? totalTakerAssetAmountAtOrderExchangeRate
                : remainingFillableTakerAssetAmount;

            const remainingTotalTakerAssetAmount = totalTakerAssetAmountAtOrderExchangeRate.minus(takerAssetFillAmount);
            totalMakerAssetAmount = orderCalculationUtils.getMakerFillAmount(
                signedOrder,
                remainingTotalTakerAssetAmount,
            );
            takerAssetFillAmounts.push(takerAssetFillAmount);
        });

        return takerAssetFillAmounts;
    }

    private async _getBatchOrderAndTraderInfoAsync(
        signedOrders: SignedOrder[],
        takerAddress: string,
        chainId: number,
    ): Promise<OrderAndTraderInfo[]> {
        const contractWrappers = this._chainIdToContractWrappers[chainId];
        const signatures = _.map(signedOrders, 'signature');
        const [orderInfos] = await contractWrappers.devUtils
            .getOrderRelevantStates(signedOrders, signatures)
            .callAsync();
        const traderInfos: TraderInfo[] = [];
        for (const signedOrder of signedOrders) {
            const [makerBalancesAndAllowances, takerBalancesAndAllowances] = await Promise.all([
                // Maker balances and allowances
                contractWrappers.devUtils
                    .getBatchBalancesAndAssetProxyAllowances(signedOrder.makerAddress, [
                        signedOrder.makerAssetData,
                        signedOrder.makerFeeAssetData,
                    ])
                    .callAsync(),

                // Taker balances and allowances
                contractWrappers.devUtils
                    .getBatchBalancesAndAssetProxyAllowances(takerAddress, [
                        signedOrder.takerAssetData,
                        signedOrder.takerFeeAssetData,
                    ])
                    .callAsync(),
            ]);

            traderInfos.push({
                // Maker
                makerBalance: makerBalancesAndAllowances[0][0],
                makerAllowance: makerBalancesAndAllowances[0][1],
                makerFeeBalance: makerBalancesAndAllowances[1][0],
                makerFeeAllowance: makerBalancesAndAllowances[1][1],

                // Taker
                takerBalance: takerBalancesAndAllowances[0][0],
                takerAllowance: takerBalancesAndAllowances[0][1],
                takerFeeBalance: takerBalancesAndAllowances[1][0],
                takerFeeAllowance: takerBalancesAndAllowances[1][1],
            });
        }
        const orderAndTraderInfos = orderInfos.map((orderInfo, index) => ({
            orderInfo,
            traderInfo: traderInfos[index],
        }));
        return orderAndTraderInfos;
    }

    private async _handleCancelsAsync(
        coordinatorOrders: Order[],
        zeroExTransaction: ZeroExTransaction,
        chainId: number,
        // txOrigin: string,
    ): Promise<Response> {
        for (const order of coordinatorOrders) {
            if (zeroExTransaction.signerAddress !== order.makerAddress) {
                throw new ValidationError([
                    {
                        field: 'signedTransaction.data',
                        code: ValidationErrorCodes.OnlyMakerCanCancelOrders,
                        reason: 'Cannot cancel order whose maker is not the 0x transaction signerAddress',
                    },
                ]);
            }
        }

        const zeroxOrderHashes: string[] = [];
        // Once we are sure all orders can be cancelled, we cancel them all at once
        for (const order of coordinatorOrders) {
            const orderHash = orderHashUtils.getOrderHashHex(order);
            zeroxOrderHashes.push(orderHash);
            // TODO: call relayer api to cancel orders
            // relayerApi.cancelOrder(orderHash);
            await orderModel.cancelAsync(order);
        }

        const cancelRequestAccepted = {
            type: EventTypes.CancelRequestAccepted,
            data: {
                zeroxOrderHashes
            },
        };
        this._broadcastCallback(cancelRequestAccepted, chainId);
        const outstandingFillSignatures = await transactionModel.getOutstandingFillSignaturessByOrdersAsync(
            coordinatorOrders,
        );


        // HACK(fabio): We want to re-use approvalSignatures for cancellation requests
        // but they don't expire. So we hard-code `0` as the expiration
        // const ZERO = 0;
        // const response = await this._generateApprovalSignatureAsync(
        //     txOrigin,
        //     coordinatorOrders,
        //     chainId,
        //     ZERO,
        // );

        return {
            status: HttpStatus.OK,
            body: {
                outstandingFillSignatures,
                zeroxOrderHashes,
            },
        };
    }

    private async _handleFillsAsync(
        coordinatorOrders: Order[],
        txOrigin: string,
        zeroExTransaction: ZeroExTransaction,
        takerAssetFillAmounts: BigNumber[],
        chainId: number,
    ): Promise<Response> {
        let ordersRefusedApproval = await Handlers._validateOrdersAsync(zeroExTransaction, coordinatorOrders, takerAssetFillAmounts);
        const transactionHash = transactionHashUtils.getTransactionHashHex(zeroExTransaction);
        const fillRequestReceivedEvent = {
            type: EventTypes.FillRequestReceived,
            data: {
                transactionHash,
            },
        };
        this._broadcastCallback(fillRequestReceivedEvent, chainId);
        await utils.sleepAsync(this._configs.SELECTIVE_DELAY_MS); // Await selective delay

        // Check that still a valid fill request after selective delay
        if (this._configs.SELECTIVE_DELAY_MS !== 0) {
            const invalidOrders = await Handlers._validateOrdersAsync(
                zeroExTransaction,
                coordinatorOrders,
                takerAssetFillAmounts,
            );
            ordersRefusedApproval = [...ordersRefusedApproval, ...invalidOrders];
        }

        const prunedCoordinatorOrders = coordinatorOrders.filter(coordinatorOrder => {
            return !ordersRefusedApproval.includes(orderHashUtils.getOrderHashHex(coordinatorOrder));
        });

        // Compute approval expiration time and assert transaction expiration
        const approvalExpirationTimeSeconds =
            utils.getCurrentTimestampSeconds() + this._configs.EXPIRATION_DURATION_SECONDS;
        if (zeroExTransaction.expirationTimeSeconds.gt(approvalExpirationTimeSeconds)) {
            throw new ValidationError([
                {
                    field: 'signedTransaction.expirationTimeSeconds',
                    code: ValidationErrorCodes.TransactionExpirationTooHigh,
                    reason: `Expiration cannot exceeed ${this._configs.EXPIRATION_DURATION_SECONDS} seconds after approval by the coordinator server (expected value to be less or equal to ${approvalExpirationTimeSeconds}})`,
                },
            ]);
        }

        // Generate response and record in DB
        const response = await this._generateApprovalSignatureAsync(
            txOrigin,
            prunedCoordinatorOrders,
            chainId,
            approvalExpirationTimeSeconds,
        );
        await transactionModel.createAsync(
            transactionHash,
            txOrigin,
            response.signatures,
            response.expirationTimeSeconds,
            zeroExTransaction.signerAddress,
            prunedCoordinatorOrders,
            takerAssetFillAmounts,
        );

        return {
            status: HttpStatus.OK,
            body: {
                approvalHash: response.approvalHash,
                approvedOrderHashes: response.zeroxOrderHashes,
                ordersRefusedApproval,
                signatures: response.signatures,
                expirationTimeSeconds: response.expirationTimeSeconds,
            },
        };
    }

    private async _generateApprovalSignatureAsync(
        txOrigin: string,
        coordinatorOrders: Order[],
        chainId: number,
        approvalExpirationTimeSeconds: number,
    ): Promise<RequestTransactionResponse> {

        const verifyingContractAddress = this._cordinatorAddress;
        console.log('this._cordinatorAddress ', this._cordinatorAddress);


        const zeroxOrderHashes: string[] = coordinatorOrders.map(order => {
            return orderHashUtils.getOrderHashHex(order);
        });

        const constants = {
            COORDINATOR_DOMAIN_NAME: '0x Protocol Coordinator',
            COORDINATOR_DOMAIN_VERSION: '3.0.0',
            COORDINATOR_APPROVAL_SCHEMA: {
                name: 'CoordinatorApproval',
                parameters: [
                    { name: 'zeroxOrderHashes', type: 'bytes32[]' },
                    { name: 'txOrigin', type: 'address' },
                    { name: 'approvalExpirationTimeSeconds', type: 'uint256' },
                ],
            },
            EXCHANGE_DOMAIN_NAME: '0x Protocol',
            EXCHANGE_DOMAIN_VERSION: '2',
            DEFAULT_DOMAIN_SCHEMA: {
                name: 'EIP712Domain',
                parameters: [
                    { name: 'name', type: 'string' },
                    { name: 'version', type: 'string' },
                    { name: 'chainId', type: 'uint256' },
                    { name: 'verifyingContract', type: 'address' },
                ],
            },
        };

        const domain = {
            name: constants.COORDINATOR_DOMAIN_NAME,
            version: constants.COORDINATOR_DOMAIN_VERSION,
            verifyingContract: verifyingContractAddress,
            chainId,
        };
        const approval = {
            zeroxOrderHashes,
            txOrigin,
            approvalExpirationTimeSeconds,
        };


        const typedData = {
            primaryType: constants.COORDINATOR_APPROVAL_SCHEMA.name,
            types: {
                EIP712Domain: constants.DEFAULT_DOMAIN_SCHEMA.parameters,
                CoordinatorApproval: constants.COORDINATOR_APPROVAL_SCHEMA.parameters,
            },
            domain,
            message: approval,
        };

        // TODO: generate previous EIP712_COORDINATOR_APPROVAL_SCHEMA_HASH
        // const EIP712_COORDINATOR_APPROVAL_SCHEMA_HASH_v1 = sigUtil.TypedDataUtils.hashType(constants_v1.COORDINATOR_APPROVAL_SCHEMA.name, { CoordinatorApproval: constants_v1.COORDINATOR_APPROVAL_SCHEMA.parameters }).toString('hex');
        const EIP712_COORDINATOR_APPROVAL_SCHEMA_HASH = sigUtil.TypedDataUtils.hashType(constants.COORDINATOR_APPROVAL_SCHEMA.name, { CoordinatorApproval: constants.COORDINATOR_APPROVAL_SCHEMA.parameters }).toString('hex');
        // const encodedApproval = sigUtil.TypedDataUtils.encodeData(constants.COORDINATOR_APPROVAL_SCHEMA.name, approval, { CoordinatorApproval: constants.COORDINATOR_APPROVAL_SCHEMA.parameters }).toString('hex');


        // console.log('EIP712_COORDINATOR_APPROVAL_SCHEMA_HASH, EIP712_COORDINATOR_APPROVAL_SCHEMA_HASH_v1', [EIP712_COORDINATOR_APPROVAL_SCHEMA_HASH, EIP712_COORDINATOR_APPROVAL_SCHEMA_HASH_v1]);
        console.log('EIP712_COORDINATOR_APPROVAL_SCHEMA_HASH, EIP712_COORDINATOR_APPROVAL_SCHEMA_HASH_v1', [EIP712_COORDINATOR_APPROVAL_SCHEMA_HASH]);
        // console.log('encodedApproval ', encodedApproval);


        // const typedData = sigUtil.TypedDataUtils.encodeData(constants.COORDINATOR_APPROVAL_SCHEMA.name, approval, constants.COORDINATOR_APPROVAL_SCHEMA.parameters);	        // const typedData = sigUtil.TypedDataUtils.encodeData(constants.COORDINATOR_APPROVAL_SCHEMA.name, approval, constants.COORDINATOR_APPROVAL_SCHEMA.parameters);
        // const approvalHashBuff = sigUtil.TypedDataUtils.hashStruct(constants.COORDINATOR_APPROVAL_SCHEMA.name, approval, { CoordinatorApproval: constants.COORDINATOR_APPROVAL_SCHEMA.parameters });

        // TODO: drop the any
        const approvalHashBuff = sigUtil.TypedDataUtils.sign(typedData as any);


        // Since a coordinator can have multiple feeRecipientAddresses,
        // we need to make sure we issue a signature for each feeRecipientAddress
        // found in the orders submitted (i.e. someone can batch fill two coordinator
        // orders, each with a different feeRecipientAddress). In that case, we issue a
        // signature/expiration for each feeRecipientAddress
        const feeRecipientAddressSet = new Set<string>();
        _.each(coordinatorOrders, o => {
            feeRecipientAddressSet.add(o.feeRecipientAddress);
        });
        const signatures = [];
        const feeRecipientAddressesUsed = Array.from(feeRecipientAddressSet);
        for (const feeRecipientAddress of feeRecipientAddressesUsed) {
            // const feeRecipientIfExists = _.find(
            //     this._configs.NETWORK_ID_TO_SETTINGS[networkId].FEE_RECIPIENTS,
            //     f => f.ADDRESS === feeRecipientAddress,
            // );
            const feeRecipientIfExists = this._configs.CHAIN_ID_TO_SETTINGS[chainId].FEE_RECIPIENTS[0];
            if (feeRecipientIfExists === undefined) {
                // This error should never be hit
                throw new Error(
                    `Unexpected error: Found feeRecipientAddress ${feeRecipientAddress} that wasn't specified in config.`,
                );
            }
            const signature = ethUtil.ecsign(approvalHashBuff, Buffer.from(feeRecipientIfExists.PRIVATE_KEY, 'hex'));
            const signatureBuffer = Buffer.concat([
                ethUtil.toBuffer(signature.v),
                signature.r,
                signature.s,
                ethUtil.toBuffer(SignatureType.EIP712),
            ]);
            const approvalSignatureHex = ethUtil.addHexPrefix(signatureBuffer.toString('hex'));
            signatures.push(approvalSignatureHex);
        }

        return {
            approvalHash: approvalHashBuff.toString('hex'),
            signatures,
            expirationTimeSeconds: approvalExpirationTimeSeconds,
            zeroxOrderHashes,
        };
    }
} // tslint:disable:max-file-line-count
