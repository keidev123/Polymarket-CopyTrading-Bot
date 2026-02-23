import { Zero, MaxUint256 } from "@ethersproject/constants";
import { BigNumber } from "@ethersproject/bignumber";
import { parseUnits } from "@ethersproject/units";
import { Wallet } from "@ethersproject/wallet";
import { JsonRpcProvider } from "@ethersproject/providers";
import { Contract } from "@ethersproject/contracts";
import { resolve } from "path";
import { config as dotenvConfig } from "dotenv";
import { Chain, AssetType, ClobClient } from "@polymarket/clob-client";
import { getContractConfig } from "@polymarket/clob-client";
import { logger } from "../utils/logger";

dotenvConfig({ path: resolve(process.cwd(), ".env") });

// Minimal USDC ERC20 ABI
const USDC_ABI = [
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function allowance(address owner, address spender) external view returns (uint256)",
];

// Minimal ERC1155 ABI for ConditionalTokens
const CTF_ABI = [
    "function setApprovalForAll(address operator, bool approved) external",
    "function isApprovedForAll(address account, address operator) external view returns (bool)",
];

function getRpcCandidates(chainId: number): string[] {
    const out: string[] = [];
    const rpcUrl = process.env.RPC_URL;
    const rpcToken = process.env.RPC_TOKEN;
    if (rpcUrl) out.push(rpcUrl);

    if (chainId === 137) {
        if (rpcToken) out.push(`https://polygon-mainnet.g.alchemy.com/v2/${rpcToken}`);
        out.push(
            "https://polygon-rpc.com",
            "https://rpc.ankr.com/polygon",
            "https://polygon.llamarpc.com",
            "https://rpc-mainnet.matic.quiknode.pro",
        );
        return [...new Set(out)];
    }
    if (chainId === 80002) {
        if (rpcToken) out.push(`https://polygon-amoy.g.alchemy.com/v2/${rpcToken}`);
        out.push("https://rpc-amoy.polygon.technology");
        return [...new Set(out)];
    }
    throw new Error(`Unsupported chain ID: ${chainId}. Supported: 137 (Polygon), 80002 (Amoy)`);
}

async function getWorkingProvider(chainId: number): Promise<{ provider: JsonRpcProvider; rpcUrl: string }> {
    const candidates = getRpcCandidates(chainId);
    const errors: string[] = [];
    for (const rpcUrl of candidates) {
        const provider = new JsonRpcProvider(rpcUrl);
        try {
            await Promise.race([
                provider.getNetwork(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 7000)),
            ]);
            return { provider, rpcUrl };
        } catch (e) {
            errors.push(`${rpcUrl} -> ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    throw new Error(
        `Could not connect to any RPC endpoint for chainId=${chainId}. ` +
        `Set RPC_URL in .env. Attempts:\n- ${errors.join("\n- ")}`
    );
}

/**
 * Approve USDC to Polymarket contracts (maximum allowance)
 * Approves USDC for both ConditionalTokens and Exchange contracts
 */
export async function approveUSDCAllowance(): Promise<void> {
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
        throw new Error("PRIVATE_KEY not found in environment");
    }

    const chainId = parseInt(`${process.env.CHAIN_ID || Chain.POLYGON}`) as Chain;
    const contractConfig = getContractConfig(chainId);
    
    let address = "";
    try {
    const { provider, rpcUrl } = await getWorkingProvider(chainId);
    logger.info(`Connected to RPC: ${rpcUrl}`);
    const wallet = new Wallet(privateKey, provider);
    
    address = await wallet.getAddress();
    logger.info(`Approving USDC allowances for address: ${address}, chainId: ${chainId}`);
    logger.info(`USDC Contract: ${contractConfig.collateral}`);
    logger.info(`ConditionalTokens Contract: ${contractConfig.conditionalTokens}`);
    logger.info(`Exchange Contract: ${contractConfig.exchange}`);

    // Create USDC contract instance
    const usdcContract = new Contract(contractConfig.collateral, USDC_ABI, wallet);

    // Configure gas options
    let gasOptions: { gasPrice?: BigNumber; gasLimit?: number } = {};
    try {
        const gasPrice = await provider.getGasPrice();
        gasOptions = {
            gasPrice: gasPrice.mul(120).div(100), // 20% buffer
            gasLimit: 200_000,
        };
    } catch (error) {
        logger.warn("Could not fetch gas price, using fallback");
        gasOptions = {
            gasPrice: parseUnits("100", "gwei"),
            gasLimit: 200_000,
        };
    }

    // Check and approve USDC for ConditionalTokens contract
    const ctfAllowance = await usdcContract.allowance(address, contractConfig.conditionalTokens);
    if (!ctfAllowance.eq(MaxUint256)) {
        logger.info(`Current CTF allowance: ${ctfAllowance.toString()}, setting to MaxUint256...`);
        const tx = await usdcContract.approve(contractConfig.conditionalTokens, MaxUint256, gasOptions);
        logger.info(`Transaction hash: ${tx.hash}`);
        await tx.wait();
        logger.success("✅ USDC approved for ConditionalTokens contract");
    } else {
        logger.info("✅ USDC already approved for ConditionalTokens contract (MaxUint256)");
    }

    // Check and approve USDC for Exchange contract
    const exchangeAllowance = await usdcContract.allowance(address, contractConfig.exchange);
    if (!exchangeAllowance.eq(MaxUint256)) {
        logger.info(`Current Exchange allowance: ${exchangeAllowance.toString()}, setting to MaxUint256...`);
        const tx = await usdcContract.approve(contractConfig.exchange, MaxUint256, gasOptions);
        logger.info(`Transaction hash: ${tx.hash}`);
        await tx.wait();
        logger.success("✅ USDC approved for Exchange contract");
    } else {
        logger.info("✅ USDC already approved for Exchange contract (MaxUint256)");
    }

    // Check and approve ConditionalTokens (ERC1155) for Exchange contract
    const ctfContract = new Contract(contractConfig.conditionalTokens, CTF_ABI, wallet);
    const isApproved = await ctfContract.isApprovedForAll(address, contractConfig.exchange);
    
    if (!isApproved) {
        logger.info("Approving ConditionalTokens for Exchange contract...");
        const tx = await ctfContract.setApprovalForAll(contractConfig.exchange, true, gasOptions);
        logger.info(`Transaction hash: ${tx.hash}`);
        await tx.wait();
        logger.success("✅ ConditionalTokens approved for Exchange contract");
    } else {
        logger.info("✅ ConditionalTokens already approved for Exchange contract");
    }

    // If negRisk is enabled, also approve for negRisk contracts
    const negRisk = process.env.NEG_RISK === "true";
    if (negRisk) {
        // Approve USDC for NegRiskAdapter
        const negRiskAdapterAllowance = await usdcContract.allowance(address, contractConfig.negRiskAdapter);
        if (!negRiskAdapterAllowance.eq(MaxUint256)) {
            logger.info(`Current NegRiskAdapter allowance: ${negRiskAdapterAllowance.toString()}, setting to MaxUint256...`);
            const tx = await usdcContract.approve(contractConfig.negRiskAdapter, MaxUint256, gasOptions);
            logger.info(`Transaction hash: ${tx.hash}`);
            await tx.wait();
            logger.success("✅ USDC approved for NegRiskAdapter");
        }

        // Approve USDC for NegRiskExchange
        const negRiskExchangeAllowance = await usdcContract.allowance(address, contractConfig.negRiskExchange);
        if (!negRiskExchangeAllowance.eq(MaxUint256)) {
            logger.info(`Current NegRiskExchange allowance: ${negRiskExchangeAllowance.toString()}, setting to MaxUint256...`);
            const tx = await usdcContract.approve(contractConfig.negRiskExchange, MaxUint256, gasOptions);
            logger.info(`Transaction hash: ${tx.hash}`);
            await tx.wait();
            logger.success("✅ USDC approved for NegRiskExchange");
        }

        // Approve ConditionalTokens for NegRiskExchange
        const isNegRiskApproved = await ctfContract.isApprovedForAll(address, contractConfig.negRiskExchange);
        if (!isNegRiskApproved) {
            logger.info("Approving ConditionalTokens for NegRiskExchange...");
            const tx = await ctfContract.setApprovalForAll(contractConfig.negRiskExchange, true, gasOptions);
            logger.info(`Transaction hash: ${tx.hash}`);
            await tx.wait();
            logger.success("✅ ConditionalTokens approved for NegRiskExchange");
        }

        // Approve ConditionalTokens for NegRiskAdapter
        const isNegRiskAdapterApproved = await ctfContract.isApprovedForAll(address, contractConfig.negRiskAdapter);
        if (!isNegRiskAdapterApproved) {
            logger.info("Approving ConditionalTokens for NegRiskAdapter...");
            const tx = await ctfContract.setApprovalForAll(contractConfig.negRiskAdapter, true, gasOptions);
            logger.info(`Transaction hash: ${tx.hash}`);
            await tx.wait();
            logger.success("✅ ConditionalTokens approved for NegRiskAdapter");
        }
    }

    logger.success("All allowances approved successfully!");

    } catch (error: any) {
        const msg = error?.code || error?.message || String(error);
        if (msg.includes("INSUFFICIENT_FUNDS") || msg.includes("insufficient funds")) {
            throw new Error(
                `Insufficient POL (MATIC) for gas fees on wallet ${address || "unknown"}. ` +
                `Deposit POL and USDC.e on Polygon network to this address before running the bot.`
            );
        }
        throw error;
    }
}

/**
 * Update balance allowance in CLOB API after setting on-chain allowances
 * This syncs the on-chain allowance state with the CLOB API
 */
export async function updateClobBalanceAllowance(client: ClobClient): Promise<void> {
    try {
        logger.info("Updating CLOB API balance allowance for USDC...");
        await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        logger.success("✅ CLOB API balance allowance updated for USDC");
    } catch (error) {
        logger.error(`Failed to update CLOB balance allowance: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}

/**
 * Approve ConditionalTokens for Exchange after buying tokens
 * This ensures tokens are approved immediately after purchase so they can be sold without delay
 * Note: ERC1155 uses setApprovalForAll which approves all tokens at once (including newly bought ones)
 */
export async function approveTokensAfterBuy(): Promise<void> {
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
        throw new Error("PRIVATE_KEY not found in environment");
    }

    const chainId = parseInt(`${process.env.CHAIN_ID || Chain.POLYGON}`) as Chain;
    const contractConfig = getContractConfig(chainId);
    
    const { provider } = await getWorkingProvider(chainId);
    const wallet = new Wallet(privateKey, provider);
    
    const address = await wallet.getAddress();
    const ctfContract = new Contract(contractConfig.conditionalTokens, CTF_ABI, wallet);

    let gasOptions: { gasPrice?: BigNumber; gasLimit?: number } = {};
    try {
        const gasPrice = await provider.getGasPrice();
        gasOptions = {
            gasPrice: gasPrice.mul(120).div(100),
            gasLimit: 200_000,
        };
    } catch {
        gasOptions = {
            gasPrice: parseUnits("100", "gwei"),
            gasLimit: 200_000,
        };
    }

    try {
        const isApproved = await ctfContract.isApprovedForAll(address, contractConfig.exchange);
        
        if (!isApproved) {
            logger.info("Approving ConditionalTokens for Exchange (after buy)...");
            const tx = await ctfContract.setApprovalForAll(contractConfig.exchange, true, gasOptions);
            logger.info(`Transaction hash: ${tx.hash}`);
            await tx.wait();
            logger.success("✅ ConditionalTokens approved for Exchange");
        }

        const negRisk = process.env.NEG_RISK === "true";
        if (negRisk) {
            const isNegRiskApproved = await ctfContract.isApprovedForAll(address, contractConfig.negRiskExchange);
            if (!isNegRiskApproved) {
                logger.info("Approving ConditionalTokens for NegRiskExchange (after buy)...");
                const tx = await ctfContract.setApprovalForAll(contractConfig.negRiskExchange, true, gasOptions);
                logger.info(`Transaction hash: ${tx.hash}`);
                await tx.wait();
                logger.success("✅ ConditionalTokens approved for NegRiskExchange");
            }
        }
    } catch (error: any) {
        const msg = error?.code || error?.message || String(error);
        if (msg.includes("INSUFFICIENT_FUNDS") || msg.includes("insufficient funds")) {
            throw new Error(
                `Insufficient POL (MATIC) for gas fees on wallet ${address}. ` +
                `Deposit POL on Polygon network to approve tokens.`
            );
        }
        throw error;
    }
}

