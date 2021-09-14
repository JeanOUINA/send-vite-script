const http = require("http")
const vite = require("vitejs-notthomiz")
const HTTP_RPC = require("vitejs-notthomiz-http").default
const WS_RPC = require("vitejs-notthomiz-ws").default
const config = require("./config.json")
const ActionQueue = require("./queue")
const BigNumber = require("bignumber.js")

const viteQueue = new ActionQueue()

const url = new URL(config.VITE_NODE)
const provider = /^wss?:$/.test(url.protocol) ? 
    new WS_RPC(config.VITE_NODE, 6e5, {
        protocol: "",
        headers: "",
        clientConfig: "",
        retryTimes: Infinity,
        retryInterval: 10000
    }) : /^https?:$/.test(url.protocol) ? 
    new HTTP_RPC(config.VITE_NODE, 6e5) :
    new Error("Invalid node url: "+config.VITE_NODE)
if(provider instanceof Error)throw provider
console.log("Connecting to "+config.VITE_NODE)
const ViteAPI = new vite.ViteAPI(provider, () => {
    console.log("Provider ready !")
    console.log("Starting server")
    let address
    switch(config.VITE_LOGIN.type){
        case "mnemonic": {
            config.VITE_LOGIN.type = "seed"
            config.VITE_LOGIN.credentials = vite.wallet.getSeedFromMnemonics(config.VITE_LOGIN.credentials).seedHex
        }
        case "seed": {
            config.VITE_LOGIN.type = "private_key"
            config.VITE_LOGIN.credentials = vite.wallet.deriveKeyPairByIndex(config.VITE_LOGIN.credentials, config.VITE_LOGIN.index).privateKey
            config.VITE_LOGIN.index = 0
        }
        case "private_key": {
            if(config.VITE_LOGIN.index !== 0)throw new Error("Invalid index with private key: "+config.VITE_LOGIN.index)
            address = vite.wallet.createAddressByPrivateKey(config.VITE_LOGIN.credentials)
            break
        }
        default: {
            throw new Error("Invalid configuration for VITE_LOGIN")
        }
    }
    console.log("Using "+address.address)

    const server = http.createServer(async (req, res) => {
        if(req.headers.authorization !== config.API_KEY){
            res.writeHead(401, "Invalid Authentication").end(JSON.stringify({
                error: {
                    name: "AuthenticationError",
                    message: "Invalid Authentication."
                }
            }))
            return
        }

        let body = {}
        try{
            body = await new Promise<any>((resolve, reject) => {
                let data = "";
                req.on("data", chunk => {
                    data += chunk
                })
                req.on("end", () => {
                    try{
                        resolve(JSON.parse(data))
                    }catch(err){
                        reject(err)
                        return
                    }
                })
            })
            if(!Object.keys(actions).includes(body.action)){
                return res.writeHead(400, "Invalid Action").end(JSON.stringify({
                    error: {
                        name: "ParsingError",
                        message: "Invalid Action"
                    }
                }))
            }
            if(!Array.isArray(body.params)){
                return res.writeHead(400, "Invalid Params").end(JSON.stringify({
                    error: {
                        name: "ParsingError",
                        message: "Invalid Params"
                    }
                }))
            }
            const action = actions[body.action]
            const [statusCode, resp] = await action(body.params)
            res.writeHead(statusCode)
            res.end(JSON.stringify(resp))
        }catch(err){
            console.error(err)

            res.writeHead(400, "Invalid Body").end(JSON.stringify({
                error: {
                    name: "ParsingError",
                    message: "Invalid Body. Couldn't parse json."
                }
            }))

            return
        }
    })
    
    server.listen(config.PORT, "[::1]", () => {
        console.log("Listening on http://[::1]:"+config.PORT)
    })

    const actions = {
        send: async (tokenId, amount, destination) => {
            if(
                [tokenId, amount, destination].find(e => typeof e !== "string") ||
                !vite.utils.isValidTokenId(tokenId) ||
                !/^\d+$/.test(amount) ||
                !vite.wallet.isValidAddress(destination)
            )return [
                400,
                {
                    error: {
                        name: "ParamsError",
                        message: "Invalid Arguments."
                    }
                }
            ]
            try{
                return await viteQueue.queueAction(address.address, async () => {
                    const balances = (await ViteAPI.request("ledger_getAccountInfoByAddress", address.address))?.balanceInfoMap || {}
                    const balance = new BigNumber(balances[tokenId]?.balance || "0")
                    if(balance.isLessThan(amount)){
                        return [400, {
                            error: {
                                name: "BalanceError",
                                message: "Insufficient Balance"
                            }
                        }]
                    }

                    const accountBlock = vite.accountBlock.createAccountBlock("send", {
                        toAddress: destination,
                        address: address.address,
                        tokenId: tokenId,
                        amount: amount
                    })
                    accountBlock.setProvider(provider)
                    .setPrivateKey(address.privateKey)
                    const [
                        quota,
                        difficulty
                    ] = await Promise.all([
                        wsProvider.request("contract_getQuotaByAccount", address.address),
                        accountBlock.autoSetPreviousAccountBlock()
                        .then(() => wsProvider.request("ledger_getPoWDifficulty", {
                            address: accountBlock.address,
                            previousHash: accountBlock.previousHash,
                            blockType: accountBlock.blockType,
                            toAddress: accountBlock.toAddress,
                            data: accountBlock.data
                        }))
                    ])
                    
                    const availableQuota = new BigNumber(quota.currentQuota)
                    if(availableQuota.isLessThan(difficulty.requiredQuota)){
                        await accountBlock.PoW(difficulty.difficulty)
                    }
                    await accountBlock.sign()

                    const hash = (await accountBlock.send()).hash

                    return [200, {
                        hash: hash,
                        from: address.address,
                        to: destination,
                        tokenid: tokenId,
                        amount: amount
                    }]
                })
            }catch(err){
                return [500, {
                    error: {
                        name: err?.name||"Error",
                        message: err?.message||"Something unexpected happened, please try again later."
                    }
                }]
            }
        }
    }
})