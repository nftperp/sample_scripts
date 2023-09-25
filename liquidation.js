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

    let weth_contract = new ethers.Contract(res.data.data.weth, ERC20_ABI['abi'], signer);
    const allowance = await weth_contract.allowance(signer.address, CH_ADDY);

    if (allowance.lt(ethers.utils.parseEther('1000'))) {
        await weth_contract.approve(CH_ADDY, ethers.utils.constants.MaxUint256);
    }

    await fetchPositions();
    const tradersByAmm = getTradersByAmm();


    //If you are running a highly efficient system, you might miss trades between the time you get the list of trades and the time you start the listener. At this point you'll have to get clever. We recommend getting the PositionData from thegraph or thru on onchain mechanics
    
    contract.on('PositionChanged', async (amm, curr_trader, openNotional, size, exchangedQuote, exchangedSize, realizedPnL, fundingPayment, markPrice, ifFee, ammFee, limitFee, keeperFee, event) => {
        updateTrader(curr_trader, amm, size)

        //loop thru now to look at liquidation
        for (const amm in tradersByAmm) {
            for (const trader in tradersByAmm[amm]) {
                
                


                if (await contract.isLiquidatable(amm, trader)){
                    let amm_contract = new ethers.Contract(amm, AMM_ABI['abi'], signer);
                    let position = await contract.getPosition(amm, trader);

                    let liquidationPrice = await amm_contract.getLiquidationPrice();
                    let positionNotional = position.size.mul(liquidationPrice).div(ethers.utils.parseEther('1'))

                    console.log("------------------")        
                    console.log(ethers.utils.formatEther(position.size))
                    console.log(ethers.utils.formatEther(liquidationPrice.toString()))
                    console.log(ethers.utils.formatEther(positionNotional.toString()))
                    console.log("------------------")

                    try {
                        await contract.liquidate(amm, trader, positionNotional); //the last element reperesents the margin you want the new position to take. This new position will have a margin of ~1X.
                        deleteTrader(amm, trader);
                        console.log(`Successfully liquidated ${trader} in ${amm}`);
                    } catch (error) {
                        console.error(`Failed to liquidate ${trader} in ${amm}: ${error.message}`);
                    }
                }
            }
        }
    }); 
}

main()