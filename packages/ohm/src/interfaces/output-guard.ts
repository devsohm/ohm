type Write = NodeJS.WriteStream["write"];
type WriteCallback = (error?: Error | null) => void;
type WriteChunk = string | Uint8Array;
let depth = 0;
let protocolWrite: Write | undefined;

function diagnosticWrite(
  chunk: WriteChunk,
  encodingOrCallback?: BufferEncoding | WriteCallback,
  callback?: WriteCallback,
): boolean {
  if (encodingOrCallback instanceof Function) return process.stderr.write(chunk, encodingOrCallback);
  if (encodingOrCallback === undefined) return process.stderr.write(chunk, callback);
  return process.stderr.write(chunk, encodingOrCallback, callback);
}

export function takeOverStdout(): void {
  depth += 1;
  if (depth !== 1) return;
  protocolWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = diagnosticWrite;
}

export function restoreStdout(): void {
  if (depth === 0) return;
  depth -= 1;
  if (depth !== 0) return;
  if (protocolWrite !== undefined) process.stdout.write = protocolWrite;
  protocolWrite = undefined;
}

export function writeMachineOutput(
  chunk: string | Uint8Array,
  callback?: (error?: Error | null) => void,
): boolean {
  const write = protocolWrite ?? process.stdout.write.bind(process.stdout);
  return write(chunk, callback);
}

export async function flushRawStdout(): Promise<void> {
  const write = protocolWrite ?? process.stdout.write.bind(process.stdout);
  await new Promise<void>((resolve, reject) => {
    write("", (error?: Error | null) => { if (error === undefined || error === null) resolve(); else reject(error); });
  });
}
