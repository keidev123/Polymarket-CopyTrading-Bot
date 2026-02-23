import { ClobClient, OrderType, Side, AssetType } from "@polymarket/clob-client";
import type { UserMarketOrder, CreateOrderOptions } from "@polymarket/clob-client";
import type { CopyTradeOptions, CopyTradeResult } from "./types";
import { tradeToMarketOrder, getDefaultOrderOptions } from "./helpers";
import { logger } from "../utils/logger";
import { addHoldings, getHoldings, removeHoldings } from "../utils/holdings";
import { approveTokensAfterBuy } from "../security/allowance";
import { validateBuyOrderBalance, displayWalletBalance } from "../utils/balance";
import { simulateTx } from "../utils/simulateOrder";
import { Wallet } from "@ethersproject/wallet";

function describeOrderFailure(status: string | number | undefined): string {
    const s = String(status);
    if (s === "403") {
        return "Incorrect region — Polymarket blocks trading from this server's location. " +
            "Use a server in an allowed region or route traffic through a VPN/proxy.";
    }
    if (s === "401") return "Authentication failed — check your API credentials.";
    if (s === "429") return "Rate limited — too many requests, slow down.";
    return `Order failed (status: ${status || "unknown"})`;
}

export class TradeOrderBuilder {
    private client: ClobClient;
    private simulateTxDone: boolean = false;

    constructor(client: ClobClient) {
        this.client = client;
    }

    /**
     * Create a signed order, optionally simulate it (first time only), then post it.
     */
    private async createSimulateAndPost(
        marketOrder: UserMarketOrder,
        orderOptions: Partial<CreateOrderOptions>,
        orderType: OrderType.FOK | OrderType.FAK
    ) {
        const simulateUrl = process.env.CLOB_SIMULATE_URL || "https://polymarket.clob.health";

        const signedOrder = await this.client.createMarketOrder(marketOrder, orderOptions);

        if (!this.simulateTxDone) {
            this.simulateTxDone = true;
            try {
                const wallet = new Wallet(process.env.PRIVATE_KEY!);
                const key = { address: wallet.address, signer: wallet.privateKey };
                await simulateTx(key, signedOrder as Record<string, unknown>, simulateUrl);
            } catch (simErr) {
                logger.warn(
                    `Tx simulate failed (continuing to post): ${simErr instanceof Error ? simErr.message : String(simErr)}`
                );
            }
        }

        const origErr = console.error;
        console.error = (...args: any[]) => {
            const s = args.map(String).join(" ");
            if (s.includes("[CLOB Client] request error")) return;
            origErr.apply(console, args);
        };
        try {
            return await this.client.postOrder(signedOrder, orderType);
        } catch (err: any) {
            const msg = err?.data?.error || err?.message || String(err);
            if (msg.includes("Trading restricted") || msg.includes("geoblock")) {
                throw new Error("Order rejected: trading is restricted in your region. Use a VPN or check https://docs.polymarket.com/developers/CLOB/geoblock");
            }
            throw err;
        } finally {
            console.error = origErr;
        }
    }

    /**
     * Copy a trade by placing a market order
     */
    async copyTrade(options: CopyTradeOptions): Promise<CopyTradeResult> {   
        try {
            const { trade, tickSize = "0.01", negRisk = false, orderType = OrderType.FAK } = options;
            const marketId = trade.conditionId;
            const tokenId = trade.asset;

            // For SELL orders, check holdings and sell all available
            if (trade.side.toUpperCase() === "SELL") {
                const holdingsAmount = getHoldings(marketId, tokenId);
                
                if (holdingsAmount <= 0) {
                    logger.warn(
                        `No holdings found for token ${tokenId} in market ${marketId}. ` +
                        `Skipping SELL order.`
                    );
                    return {
                        success: false,
                        error: "No holdings available to sell",
                    };
                }

                // Validate available balance (accounting for open orders)
                // const balanceCheck = await validateSellOrderBalance(
                //     this.client,
                //     tokenId,
                //     holdingsAmount
                // );

                // if (!balanceCheck.valid) {
                //     logger.warn(
                //         `Insufficient balance for SELL order. ` +
                //         `Required: ${balanceCheck.required}, Available: ${balanceCheck.available}. ` +
                //         `Using available balance instead.`
                //     );
                    
                //     if (balanceCheck.available <= 0) {
                //         return {
                //             success: false,
                //             error: `Insufficient token balance. Available: ${balanceCheck.available}`,
                //         };
                //     }
                // }

                // Use the minimum of holdings and available balance
                // const sellAmount = Math.min(holdingsAmount, balanceCheck.available);
                const sellAmount = holdingsAmount;

                // logger.info(
                //     `Selling tokens: Holdings=${holdingsAmount}, Available=${balanceCheck.available}, Selling=${sellAmount}`
                // );

                // For SELL, amount is in shares
                const marketOrder: UserMarketOrder = {
                    tokenID: tokenId,
                    side: Side.SELL,
                    amount: sellAmount,
                    orderType,
                };

                const orderOptions: Partial<CreateOrderOptions> = getDefaultOrderOptions(tickSize, negRisk);

                logger.info(`Placing SELL market order: ${sellAmount} shares (type: ${orderType})`);
                
                const response = await this.createSimulateAndPost(
                    marketOrder,
                    orderOptions,
                    orderType
                );

                const sellStatus = response?.status;
                const sellFailed = !response || !response.orderID ||
                    (sellStatus && sellStatus !== "FILLED" && sellStatus !== "PARTIALLY_FILLED" && sellStatus !== "MATCHED");

                if (sellFailed) {
                    return {
                        success: false,
                        error: describeOrderFailure(sellStatus),
                    };
                }

                const tokensSold = response.makingAmount 
                    ? parseFloat(response.makingAmount) 
                    : sellAmount;

                if (tokensSold > 0) {
                    removeHoldings(marketId, tokenId, tokensSold);
                    logger.info(`✅ Removed ${tokensSold} tokens from holdings: ${marketId} -> ${tokenId}`);
                } else {
                    logger.warn("No tokens were sold - not removing from holdings");
                }

                logger.success(
                    `SELL order executed! ` +
                    `OrderID: ${response.orderID || "N/A"}, ` +
                    `Tokens sold: ${tokensSold}, ` +
                    `Status: ${response.status || "N/A"}`
                );

                return {
                    success: true,
                    orderID: response.orderID,
                    transactionHashes: response.transactionsHashes,
                    marketOrder,
                };
            }

            // For BUY orders, proceed normally
            logger.info(
                `Building order to copy trade: ${trade.side} ${trade.size} @ ${trade.price} ` +
                `for token ${tokenId.substring(0, 20)}...`
            );

            // Convert trade to market order
            const marketOrder = tradeToMarketOrder(options);
            
            // Update CLOB API balance allowance before checking (ensures latest state)
            try {
                await this.client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
            } catch (error) {
                logger.warn(`Failed to update balance allowance: ${error instanceof Error ? error.message : String(error)}`);
            }
            
            // Display current wallet balance
            await displayWalletBalance(this.client);
            
            // Validate available USDC balance before placing BUY order
            const balanceCheck = await validateBuyOrderBalance(
                this.client,
                marketOrder.amount
            );

            if (!balanceCheck.valid) {
                logger.warn(
                    `Insufficient USDC balance for BUY order. ` +
                    `Required: ${balanceCheck.required}, Available: ${balanceCheck.available}. ` +
                    `Adjusting order amount to available balance.`
                );
                
                if (balanceCheck.available <= 0) {
                    return {
                        success: false,
                        error: `Insufficient USDC balance. Available: ${balanceCheck.available}`,
                    };
                }

                // Adjust order amount to available balance
                marketOrder.amount = balanceCheck.available;
                logger.info(`Adjusted order amount to available balance: ${marketOrder.amount}`);
            }
            
            // Get order options
            const orderOptions: Partial<CreateOrderOptions> = getDefaultOrderOptions(tickSize, negRisk);

            // Place the market order
            logger.info(`Placing ${marketOrder.side} market order: ${marketOrder.amount} (type: ${orderType})`);
            
            const response = await this.createSimulateAndPost(
                marketOrder,
                orderOptions,
                orderType
            );

            const buyStatus = response?.status;
            const buyFailed = !response || !response.orderID ||
                (buyStatus && buyStatus !== "FILLED" && buyStatus !== "PARTIALLY_FILLED" && buyStatus !== "MATCHED");

            if (buyFailed) {
                return {
                    success: false,
                    error: describeOrderFailure(buyStatus),
                };
            }

            const tokensReceived = response.takingAmount 
                ? parseFloat(response.takingAmount) 
                : 0;
            
            if (tokensReceived > 0) {
                addHoldings(marketId, tokenId, tokensReceived);
                logger.info(`✅ Added ${tokensReceived} tokens to holdings: ${marketId} -> ${tokenId}`);
            } else {
                const estimatedTokens = marketOrder.amount / (trade.price || 1);
                if (estimatedTokens > 0) {
                    addHoldings(marketId, tokenId, estimatedTokens);
                    logger.warn(`Using estimated token amount: ${estimatedTokens} (actual amount not in response)`);
                } else {
                    logger.warn("No tokens received and cannot estimate - not adding to holdings");
                }
            }

            try {
                await approveTokensAfterBuy();
            } catch (error) {
                logger.warn(`Failed to approve tokens after buy: ${error instanceof Error ? error.message : String(error)}`);
            }

            logger.success(
                `BUY order executed! ` +
                `OrderID: ${response.orderID || "N/A"}, ` +
                `Tokens received: ${tokensReceived || "estimated"}, ` +
                `Status: ${response.status || "N/A"}`
            );

            return {
                success: true,
                orderID: response.orderID,
                transactionHashes: response.transactionsHashes,
                marketOrder,
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            
            // If it's a balance/allowance error, show current balance
            if (errorMessage.includes("not enough balance") || errorMessage.includes("allowance")) {
                logger.error("═══════════════════════════════════════");
                logger.error("❌ ORDER FAILED: Balance/Allowance Error");
                logger.error("═══════════════════════════════════════");
                
                // Try to display current balance
                try {
                    await displayWalletBalance(this.client);
                    // Try updating allowance and retry
                    logger.info("Attempting to update balance allowance...");
                    await this.client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
                } catch (balanceError) {
                    logger.error(`Failed to get balance: ${balanceError instanceof Error ? balanceError.message : String(balanceError)}`);
                }
                
                logger.error("═══════════════════════════════════════");
            }
            
            logger.error(`Failed to copy trade: ${errorMessage}`);
            
            return {
                success: false,
                error: errorMessage,
            };
        }
    }

    /**
     * Place a market buy order
     */
    async placeMarketBuy(
        tokenID: string,
        amount: number,
        options?: {
            tickSize?: CreateOrderOptions["tickSize"];
            negRisk?: boolean;
            orderType?: OrderType.FOK | OrderType.FAK;
            price?: number;
        }
    ): Promise<CopyTradeResult> {
        const marketOrder: UserMarketOrder = {
            tokenID,
            side: Side.BUY,
            amount,
            orderType: options?.orderType || OrderType.FAK,
            ...(options?.price !== undefined && { price: options.price }),
        };

        const orderOptions: Partial<CreateOrderOptions> = getDefaultOrderOptions(
            options?.tickSize,
            options?.negRisk
        );

        try {
            const response = await this.createSimulateAndPost(
                marketOrder,
                orderOptions,
                marketOrder.orderType || OrderType.FAK
            );

            return {
                success: true,
                orderID: response.orderID,
                transactionHashes: response.transactionsHashes,
                marketOrder,
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                error: errorMessage,
            };
        }
    }

    /**
     * Place a market sell order
     */
    async placeMarketSell(
        tokenID: string,
        amount: number,
        options?: {
            tickSize?: CreateOrderOptions["tickSize"];
            negRisk?: boolean;
            orderType?: OrderType.FOK | OrderType.FAK;
            price?: number;
        }
    ): Promise<CopyTradeResult> {
        const marketOrder: UserMarketOrder = {
            tokenID,
            side: Side.SELL,
            amount,
            orderType: options?.orderType || OrderType.FAK,
            ...(options?.price !== undefined && { price: options.price }),
        };

        const orderOptions: Partial<CreateOrderOptions> = getDefaultOrderOptions(
            options?.tickSize,
            options?.negRisk
        );

        try {
            const response = await this.createSimulateAndPost(
                marketOrder,
                orderOptions,
                marketOrder.orderType || OrderType.FAK
            );

            return {
                success: true,
                orderID: response.orderID,
                transactionHashes: response.transactionsHashes,
                marketOrder,
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                error: errorMessage,
            };
        }
    }
}

