/** Who wrote a work-order message: the transport's `user` / `assistant` / `system` discriminator, named once. It is not a permission role. */
type Authored = { role: string };
export const fromPerson = (m: Authored): boolean => m.role === "user";
export const fromAgentModel = (m: Authored): boolean => m.role === "assistant";
