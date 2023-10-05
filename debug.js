const { ethers } = require("ethers");
const axios = require("axios").default;
const { fetchPositions } = require("./fetchPositions");
const { getTradersByAmm, updateTrader, deleteTrader } = require('./stateManager');
const ERC20_ABI = require("./abi/ERC20.json");
const AMM_ABI = require("./abi/AMM.json");

require("dotenv").config();

const CH_ABI = require("./abi/ClearingHouse.json");

let provider = new ethers.providers.AlchemyProvider(
    'arbitrum',
    process.env.ALCHEMY_KEY
);

let signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

async function main(){
    let res = await axios.get("https://api.nftperp.xyz/contracts");
    let CH_ADDY = res.data.data.clearingHouse;
    let contract = new ethers.Contract(CH_ADDY, CH_ABI['abi'], signer);

    contract.on('PositionChanged', async (amm, curr_trader, openNotional, size, exchangedQuote, exchangedSize, realizedPnL, fundingPayment, markPrice, ifFee, ammFee, limitFee, keeperFee, event) => {
        console.log(amm, curr_trader, openNotional, size, exchangedQuote, exchangedSize, realizedPnL, fundingPayment, markPrice, ifFee, ammFee, limitFee, keeperFee, event)

    });
}

main()