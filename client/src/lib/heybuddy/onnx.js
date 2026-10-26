/** @module onnx */
// Changed from upstream hey-buddy: the runtime is not imported by name (Vite cannot resolve
// upstream's fallback path). Reem loads ONNX Runtime itself from /heybuddy/ort/ and hands it
// over with useRuntime() before any model is made; see ../wakeword.js.
import { sleep } from "./helpers.js";

let initialized = false, Tensor, InferenceSession;

export function useRuntime(ort) {
    Tensor = ort.Tensor;
    InferenceSession = ort.InferenceSession;
    initialized = true;
}

/**
 * Wrapper for ONNX Runtime Web API.
 */
export class ONNX {
    static async waitForInitialization() {
        while (!initialized) {
            await sleep(10);
        }
    }

    static async createTensor(dtype, data, dims) {
        await ONNX.waitForInitialization();
        return new Tensor(dtype, data, dims);
    }

    static async createInferenceSession(model, options = {}) {
        await ONNX.waitForInitialization();
        return await InferenceSession.create(model, options);
    }
}
