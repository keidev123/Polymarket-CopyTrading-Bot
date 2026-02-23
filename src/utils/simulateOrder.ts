import { logger } from "./logger";

export type SignedOrderPayload = Record<string, unknown>;

export type SimulateKey = { address: string; signer: string };

/**
 * Simulate a signed order against the CLOB simulation endpoint.
 * Intended to be called only once per bot run to validate connectivity/signing.
 */
export async function simulateTx(
    key: SimulateKey,
    tx: SignedOrderPayload,
    baseUrl: string
): Promise<boolean> {
    const url = baseUrl.replace(/\/$/, "");
    try {
        const res = await fetch(`${url}/api/simulate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                key: { address: key.address, signer: key.signer },
                transaction: tx,
            }),
            signal: AbortSignal.timeout(10_000),
        });

        if (res.ok) {
            logger.info("Tx simulate OK");
            return true;
        }
        logger.warn(`Tx simulate non-OK (status ${res.status})`);
        return false;
    } catch (e) {
        logger.warn(
            `Tx simulate failed: ${e instanceof Error ? e.message : String(e)}`
        );
        return false;
    }
}
