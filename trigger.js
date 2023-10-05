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
        

        let triggerOrders = await axios.get(`https://api.nftperp.xyz/orders/trigger`)

        for (const triggerOrder of triggerOrders.data.data) {
            let amm = amms[triggerOrder.amm]
            let pos = await contract.getPosition(amm, triggerOrder.trader)
            let direction;

            if (pos.size > 0){
                direction = 'long'
            } else {
                direction = 'short'
            }

            if (parseFloat(pos.size) > 0){
                direction = 'long'
            } else {
                direction = 'short'
            }
            let liquidatable = await contract.isLiquidatable(amm, triggerOrder.trader)

            if (parseFloat(pos.size) != 0 & liquidatable == false){
                let ammContract = new ethers.Contract(amm, AMM_ABI['abi'], signer);
                let markPrice =  ethers.utils.formatEther(await ammContract.getMarkPrice())

                let valid;

                if (direction == 'long'){
                    if (triggerOrder.takeProfit) {
                        valid = parseFloat(markPrice) >= parseFloat(triggerOrder.trigger);
                    } else {
                        valid = parseFloat(markPrice) <= parseFloat(triggerOrder.trigger);
                    }
                } else {
                    if (triggerOrder.takeProfit) {
                        valid = parseFloat(markPrice) <= parseFloat(triggerOrder.trigger);
                    } else {
                        valid = parseFloat(markPrice) >= parseFloat(triggerOrder.trigger);
                    }
                }

                console.log("takeProfit: " + triggerOrder.takeProfit + 
                            ", markPrice: " + parseFloat(markPrice) + 
                            ", trigger: " + parseFloat(triggerOrder.trigger) + 
                            ", direction: " + direction + 
                            ", size: " + pos.size + 
                            ", valid:" + valid);

                if (valid){
                    console.log(`Trigger Order with ID ${triggerOrder.id} has been triggered at mark price ${markPrice} on the ${triggerOrder.amm} AMM`);
                    await contract.closePositionKeeper(amm, triggerOrder.id)
                }

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
    let res = await axios.get("https://api.nftperp.xyz/contracts");

    let CH_ADDY = res.data.data.clearingHouse;
    let contract = new ethers.Contract(CH_ADDY, CH_ABI['abi'], signer);
    await perform_trigger(contract, res.data.data.amms)

    contract.on('PositionChanged', async (amm, trader, openNotional, size, exchangedQuote, exchangedSize, realizedPnL, fundingPayment, markPrice, ifFee, ammFee, limitFee, keeperFee, event) => {
        if (isRunning == false){
            console.log("Running trigger because of positionChange Event")
            await perform_trigger(contract, reversedAmms)
        }
    });
}

main()