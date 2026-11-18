/** The Models screen's writes, in one place (the view-import baseline counts one ops import for them). */
import { ops } from "../../api/ops";

export const setModelEnabled = (id: string, on: boolean) => ops.setModelEnabled(id, on);
export const discoverVendorModels = (id: string) => ops.discoverVendorModels(id);
