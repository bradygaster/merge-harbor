// Module resolve hook: route the Copilot SDK import to the local preview stub.
const stub = new URL("./copilot-sdk-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@github/copilot-sdk/extension") {
        return { url: stub, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
