import * as _ from 'lodash';

export const configs = {
    // Network port to listen on
    HTTP_PORT: process.env.COORDINATOR_HTTP_PORT === undefined ? 3001 : _.parseInt(process.env.COORDINATOR_HTTP_PORT),
    // Ethereum RPC url
    CHAIN_ID_TO_SETTINGS: {
        // 1: {
        //     FEE_RECIPIENTS: [
        //         {
        //             ADDRESS: process.env.MAINNET_FEE_RECIPIENT_ADDRESS_ONE || '0x86a7a0c4e275710c7d077e93709d07b0cd672462',
        //             PRIVATE_KEY: process.env.MAINNET_FEE_RECIPIENT_PRIVATE_KEY_ONE || 'ef46ce62d3a8b7323304155efe149f21a83b6a7fc8d169d6532ea3818ed96dd5',
        //         },
        //     ],
        //     RPC_URL: process.env.MAINNET_RPC_URL || 'https://mainnet.infura.io/v3/e2c067d9717e492091d1f1d7a2ec55aa',
        // },
        // 42: {
        //     FEE_RECIPIENTS: [
        //         {
        //             ADDRESS: process.env.KOVAN_FEE_RECIPIENT_ADDRESS_ONE || '0x86a7a0c4e275710c7d077e93709d07b0cd672462',
        //             PRIVATE_KEY: process.env.KOVAN_FEE_RECIPIENT_PRIVATE_KEY_ONE || 'ef46ce62d3a8b7323304155efe149f21a83b6a7fc8d169d6532ea3818ed96dd5',
        //         },
        //     ],
        //     COORDINATOR_CONTRACT_ADDRESS: '0x0aef6721f4e30c8c2496cf060e4818f4374169c6', // new approval struct
        //     RPC_URL: process.env.KOVAN_RPC_URL || 'https://kovan.infura.io/v3/bc9118cc927a492ea1e57e4636e63b01',
        // },
        4: {
            FEE_RECIPIENTS: [
                {
                    ADDRESS: process.env.KOVAN_FEE_RECIPIENT_ADDRESS_ONE || '0x86a7a0c4e275710c7d077e93709d07b0cd672462',
                    PRIVATE_KEY: process.env.KOVAN_FEE_RECIPIENT_PRIVATE_KEY_ONE || 'ef46ce62d3a8b7323304155efe149f21a83b6a7fc8d169d6532ea3818ed96dd5',
                },
            ],
            COORDINATOR_CONTRACT_ADDRESS: '0x73d213954b95e03194a2638940d4317cc0416540', // new approval struct
            // latest:
            // COORDINATOR_CONTRACT_ADDRESS: '0xaf9e170c538d17244a19d3508d835ba39872b277', // new approval struct
            RPC_URL: process.env.KOVAN_RPC_URL || 'https://rinkeby.infura.io/v3/bc9118cc927a492ea1e57e4636e63b01',
        },
    },
    // Optional selective delay on fill requests
    SELECTIVE_DELAY_MS:
        process.env.SELECTIVE_DELAY_MS === undefined ? 1000 : _.parseInt(process.env.SELECTIVE_DELAY_MS),
    EXPIRATION_DURATION_SECONDS:
        process.env.EXPIRATION_DURATION_SECONDS === undefined
            ? 3600
            : _.parseInt(process.env.EXPIRATION_DURATION_SECONDS), // 1 minute
};
