import * as bodyParser from "body-parser"
import * as express from "express"
import * as jwt from "jsonwebtoken"
import { getLogger } from "log4js"
import opn = require("opn")
import * as React from "react"
import { matchPath } from "react-router"
import { matchRoutes, renderRoutes } from "react-router-config"
import { SignedTx } from "../../common/txSigned"
import { IConsensus } from "../../consensus/iconsensus"
import { globalOptions } from "../../main"
import { IPeer } from "../../network/ipeer"
import { RestManager } from "../../rest/restManager"
import * as proto from "../../serialization/proto"
import * as Hycon from "../../server"
import { App, routes } from "../client/app"
import { indexRender } from "./index"
import { RestServer } from "./restServer"
const logger = getLogger("RestClient")
const apiVersion = "v1"

// tslint:disable:object-literal-sort-keys
export class HttpServer {
    public app: express.Application
    public rest: RestServer
    public hyconServer: RestManager

    constructor(hyconServer: RestManager, port: number = 2442, options: any) {
        this.app = express()
        this.config()
        this.app.all("/*", (req: express.Request, res: express.Response, next: express.NextFunction) => {
            // res.header("Access-Control-Allow-Origin", "localhost")
            if (options.nonLocal || globalOptions.public_rest === true) {
                res.header("Access-Control-Allow-Origin", "*")
            } else {
                res.header("Access-Control-Allow-Origin", "https://wallet.hycon.io")
            }
            res.header("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE")
            res.header("Access-Control-Allow-Headers", "Content-type, Accept")
            res.header("X-FRAME-OPTIONS", "DENY")
            if (req.method === "OPTIONS") {
                res.status(200).end()
            } else {
                next()
            }
        })
        this.app.use((req: express.Request, res: express.Response, next: express.NextFunction) => this.reactRoute(req, res, next))
        if (globalOptions.public_rest !== true) {
            this.app.use(express.static("data/clientDist"))
            this.app.use(express.static("node_modules"))
        }
        this.routeRest()
        this.rest = new RestServer(hyconServer.consensus, hyconServer.network, hyconServer.txQueue, hyconServer.miner)
        this.app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
            res.status(404)
            res.json({
                status: 404,
                timestamp: Date.now(),
                error: "INVALID_ROUTE",
                message: "resource not found",
            })
        })

        if (options.nonLocal || globalOptions.public_rest === true) {
            this.app.listen(port, () => { opn(`http://localhost:${port}`).catch((e) => logger.debug(e)) })
        } else {
            this.app.listen(port, "localhost", () => { opn(`http://localhost:${port}`).catch((e) => logger.debug(e)) })
        }

        this.hyconServer = hyconServer
        logger.info(">>>>>>> Started RESTful API")
    }

    public reactRoute(
        req: express.Request,
        res: express.Response,
        next: express.NextFunction,
    ) {
        const branches = matchRoutes(routes, req.url)
        if (globalOptions.public_rest !== true && branches.length > 0) {
            logger.info("react: " + req.url)
            const context: { url?: string } = {}
            const page = indexRender(this.rest, req.url, context)
            if (context.url) {
                res.redirect(context.url, 301)
            } else {
                res.send(page)
            }
        } else {
            logger.debug("other: " + req.url)
            next()
        }
    }

    public routeRest() {
        let router: express.Router
        router = express.Router()

        if (globalOptions.public_rest !== true) {
            // Private, only available on local
            router.get("/wallet/", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.getWalletList())
            })
            router.post("/wallet", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.createNewWallet({
                    privateKey: req.body.privateKey,
                    mnemonic: req.body.mnemonic,
                    language: req.body.language,
                    passphrase: req.body.passphrase,
                }))
            })

            router.get("/wallet/:idx", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.getWalletList(req.params.idx))
            })

            router.get("/wallet/:address/balance", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.getWalletBalance(req.params.address))
            })
            router.put("/wallet/:address/callback", async (req: express.Request, res: express.Response) => {
                res.json(await this.hyconServer.createSubscription({
                    address: req.params.address,
                    url: req.body.url,
                    from: req.body.from,
                    to: req.body.to,
                }))
            })
            router.delete("/wallet/:address/callback/:id", async (req: express.Request, res: express.Response) => {
                res.json(await this.hyconServer.deleteSubscription(req.params.address, req.params.id))
            })
            router.get("/wallet/:address/txs/:nonce?", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.getWalletTransactions(req.params.address, req.params.nonce))
            })

            router.get("/wallet/detail/:name", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.getWalletDetail(req.params.name))
            })
            router.post("/recoverWallet", async (req: express.Request, res: express.Response) => {
                res.json(
                    await this.rest.recoverWallet({
                        name: req.body.name,
                        password: req.body.password,
                        passphrase: req.body.passphrase,
                        hint: req.body.hint,
                        mnemonic: req.body.mnemonic,
                        language: req.body.language,
                    }),
                )
            })
            router.post("/signedtx", async (req: express.Request, res: express.Response) => {
                logger.debug("Route triggered")
                res.json(
                    await this.rest.outgoingSignedTx({
                        privateKey: req.body.privateKey,
                        to: req.body.to,
                        amount: req.body.amount,
                        fee: req.body.fee,
                        nonce: req.body.nonce,
                    }, async (tx: SignedTx) => {
                        const newTxs = await this.hyconServer.txQueue.putTxs([tx])
                        this.hyconServer.broadcastTxs(newTxs)
                    }),
                )
            })

            router.get("/deleteWallet/:name", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.deleteWallet(req.params.name))
            })
            router.post("/generateWallet", async (req: express.Request, res: express.Response) => {
                res.json(
                    await this.rest.generateWallet({
                        name: req.body.name,
                        password: req.body.password,
                        passphrase: req.body.passphrase,
                        hint: req.body.hint,
                        mnemonic: req.body.mnemonic,
                        language: req.body.language,
                    }),
                )
            })

            router.get("/getAllAccounts", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.getAllAccounts(req.body.name, req.body.password, req.body.startIndex))
            })
            router.get("/block/height/:height", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.getBlockAtHeight(req.params.height))
            })
            router.get("/blockList/:index", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.getBlockList(req.params.index))
            })
            router.get("/toptipHeight/", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.getTopTipHeight())
            })
            router.get("/getMnemonic/:lang", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.getMnemonic(req.params.lang))
            })

            router.get("/getMiner", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.getMiner())
            })

            router.get("/setMiner/:address", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.setMiner(req.params.address))
            })

            router.get("/startGPU", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.startGPU())
            })

            router.get("/setMinerCount/:count", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.setMinerCount(req.params.count))
            })

            router.get("/favorites", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.getFavoriteList())
            })
            router.get("/favorites/add/:alias/:address", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.addFavorite(req.params.alias, req.params.address))
            })
            router.get("/favorites/delete/:alias", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.deleteFavorite(req.params.alias))
            })

            router.post("/addWalletFile", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.addWalletFile(req.body.name, req.body.password, req.body.key))
            })

            router.get("/hint/:name", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.getHint(req.params.name))
            })

            router.get("/dupleName/:name", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.checkDupleName(req.params.name))
            })

            router.get("/peerList", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.getPeerList())
            })

            router.get("/peerConnected/:index", async (req: express.Request, res: express.Response) => {
                res.json(await this.rest.getPeerConnected(req.params.index))
            })

            router.post("/transaction", async (req: express.Request, res: express.Response) => {
                res.json(
                    await this.rest.sendTx({
                        name: req.body.name,
                        password: req.body.password,
                        address: req.body.address,
                        amount: req.body.amount,
                        minerFee: req.body.minerFee,
                        nonce: req.body.nonce,
                    }, async (tx: SignedTx) => {
                        const newTxs = await this.hyconServer.txQueue.putTxs([tx])
                        this.hyconServer.broadcastTxs(newTxs)
                    }),
                )
            })
        }

        // Public, always available
        router.post("/tx", async (req: express.Request, res: express.Response) => {
            res.json(
                await this.rest.outgoingTx({
                    signature: req.body.signature,
                    from: req.body.from,
                    to: req.body.to,
                    amount: req.body.amount,
                    fee: req.body.fee,
                    nonce: req.body.nonce,
                    recovery: req.body.recovery,
                }, async (tx: SignedTx) => {
                    const newTxs = await this.hyconServer.txQueue.putTxs([tx])
                    this.hyconServer.broadcastTxs(newTxs)
                }),
            )
        })
        router.get("/block/:hash", async (req: express.Request, res: express.Response) => {
            res.json(await this.rest.getBlock(req.params.hash))
        })
        router.get("/address/:address", async (req: express.Request, res: express.Response) => {
            res.json(await this.rest.getAddressInfo(req.params.address))
        })
        router.get("/language", async (req: express.Request, res: express.Response) => {
            res.json("error TS2339: Property 'getLanguage' does not exist on type 'RestServer'.")
            // res.json(await this.rest.getLanguage())
        })
        router.get("/tx/:hash", async (req: express.Request, res: express.Response) => {
            res.json(await this.rest.getTx(req.params.hash))
        })
        router.get("/txList/:index", async (req: express.Request, res: express.Response) => {
            res.json(await this.rest.getPendingTxs(req.params.index))
        })
        router.get("/nextTxs/:address/:txHash/:index", async (req: express.Request, res: express.Response) => {
            res.json(await this.rest.getNextTxs(req.params.address, req.params.txHash, req.params.index))
        })
        router.get("/nextTxsInBlock/:blockhash/:txHash/:index", async (req: express.Request, res: express.Response) => {
            res.json(await this.rest.getNextTxsInBlock(req.params.blockhash, req.params.txHash, req.params.index))
        })
        router.get("/getMinedInfo/:address/:blockHash/:index", async (req: express.Request, res: express.Response) => {
            res.json(await this.rest.getMinedBlocks(req.params.address, req.params.blockHash, req.params.index))
        })

        router.get("/getLedgerWallet/:startIndex/:count", async (req: express.Request, res: express.Response) => {
            res.json(await this.rest.getLedgerWallet(req.params.startIndex, req.params.count))
        })

        router.get("/sendTxWithLedger/:index/:from/:to/:amount/:fee", async (req: express.Request, res: express.Response) => {
            res.json(await this.rest.sendTxWithLedger(
                req.params.index,
                req.params.from,
                req.params.to,
                req.params.amount,
                req.params.fee,
                async (tx: SignedTx) => {
                    const newTxs = await this.hyconServer.txQueue.putTxs([tx])
                    this.hyconServer.broadcastTxs(newTxs)
                }))
        })

        router.get("/possibilityLedger", async (req: express.Request, res: express.Response) => {
            res.json(await this.rest.possibilityLedger())
        })

        router.get("/getMarketCap", async (req: express.Request, res: express.Response) => {
            res.json(await this.rest.getMarketCap())
        })

        this.app.use(`/api/${apiVersion}`, router)
    }

    public config() {
        this.app.use(bodyParser.json())
    }
}
