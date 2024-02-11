const { ethers } = require("ethers");
const axios = require("axios").default;
const { fetchPositions } = require("./fetchPositions"); // Import the new library
const { getTradersByAmm, updateTrader, deleteTrader } = require('./stateManager');
require("dotenv").config();

const CH_ABI = require("./abi/ClearingHouse.json");
const AMM_ABI = require("./abi/AMM.json");

let provider = new ethers.providers.AlchemyProvider(
    'arbitrum',
    process.env.ALCHEMY_KEY
);

let signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
let isRunning = false;


async function perform_trigger(contract, amms){
    await new Promise(r => setTimeout(r, Math.random() * 500));

    if(isRunning) {
        return;
    }

    isRunning = true;

    try{
        let triggerOrders = await axios.get(`https://live.nftperp.xyz/orders/trigger`)

        for (const triggerOrder of triggerOrders.data.data) {
            let amm = amms[triggerOrder.amm]
            if (await contract.isTriggerOrderValid(triggerOrder.id)){
                await contract.closePositionKeeper(triggerOrder.id)
                console.log(`Trigger Order with ID ${triggerOrder.id} has been triggered at on the ${triggerOrder.amm} AMM`);
            }

        }
    }
    catch (error) {
        console.error(error)
    } finally {
        isRunning = false;
    }
}

async function main(){
    let res = await axios.get("https://live.nftperp.xyz/contracts");

    let CH_ADDY = res.data.data.clearingHouse;
    let contract = new ethers.Contract(CH_ADDY, CH_ABI['abi'], signer);
    await perform_trigger(contract, res.data.data.amms)

    contract.on('PositionChanged', async (amm, trader, margin, size, exchangedQuote, exchangedBase, realizedPnL, fundingPayment, markPrice, ifFee, ammFee, limitFee, liquidatorFee, keeperFee, tradeType, event) => {        
        if (isRunning == false){
            console.log("Running trigger because of positionChange Event")
            await perform_trigger(contract, res.data.data.amms)
        }
    });

    while (true){
        // wait 1 minute
        await new Promise(r => setTimeout(r, 60000));

        if (isRunning == false){
            console.log("Running trigger because of minute wait")
            perform_trigger(contract, res.data.data.amms)
        }
    }
}

main()