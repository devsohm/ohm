import type { Component } from "../tui.js";
import {
  allocateImageId,
  getCapabilities,
  getImageDimensions,
  renderImage,
  type ImageDimensions,
  type ImageRenderOptions,
} from "../terminal-image.js";
import { truncateToWidth } from "../utils.js";
export interface ImageTheme { fallbackColor: (value: string) => string }
export type ImageOptions = ImageRenderOptions;
export class Image implements Component {
  #imageId: number | undefined;
  constructor(readonly data: string, readonly mimeType: string, readonly theme: ImageTheme, readonly options: ImageOptions = {}, readonly dimensions?: ImageDimensions) { this.#imageId = options.imageId; }
  getImageId(): number | undefined { return this.#imageId; }
  render(width: number): string[] {
    const dimensions = this.dimensions ?? getImageDimensions(this.data, this.mimeType) ?? undefined;
    if (this.#imageId === undefined && this.mimeType === "image/png" && getCapabilities().images === "kitty") this.#imageId = allocateImageId();
    const options: ImageRenderOptions = { moveCursor: false, ...this.options };
    if (this.#imageId !== undefined) options.imageId = this.#imageId;
    const lines = renderImage(this.data, this.mimeType, width, options, dimensions);
    return lines.map((line) => line === "" || line.includes("\x1b_G") || line.includes("\x1b]1337;") ? line : this.theme.fallbackColor(truncateToWidth(line, width)));
  }
  invalidate(): void {}
}
