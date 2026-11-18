/** Writes of the Models screen that views run through `useCommand` (rule F-02: views do not import `api/ops`). */
import { useCommand } from "../lib/useCommand";
import { ops } from "./ops";

/** Lists a connected vendor's models again; the server adds the new ones and keeps switches and prices already set. */
export const useDiscoverModels = () => useCommand((vendorId: string) => ops.discoverVendorModels(vendorId), { ok: false });

/** Publishes the price of one model (USD per million tokens) as a new price version. */
export const usePublishPrice = () => useCommand((model: string, name: string, inP: number, outP: number) => ops.publishPrices({ [model]: { in: inP, out: outP } }, undefined, `Price set for ${name}`), { ok: false });
