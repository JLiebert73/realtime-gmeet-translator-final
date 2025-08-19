class PCMWorklet extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel0 = input[0];
    if (!channel0) return true;
    // Copy to a transferable buffer
    const copy = new Float32Array(channel0.length);
    copy.set(channel0);
    this.port.postMessage(copy, [copy.buffer]);
    return true;
  }
}

registerProcessor('pcm-worklet', PCMWorklet);


