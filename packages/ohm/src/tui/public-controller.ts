import { TuiController as InternalTuiController } from "./controller.js";
import { INTERNAL_TUI_FRAME_PROJECTOR } from "./frame-projector.js";
import { internalCreateRichTuiFrameProjector } from "./rich-frame-projector.js";
import type { TuiControllerOptions } from "./types.js";

/** Public controller constructor. Full terminals always use the rich projector. */
export class TuiController extends InternalTuiController {
  constructor(options: TuiControllerOptions = {}) {
    super({
      ...options,
      [INTERNAL_TUI_FRAME_PROJECTOR]: internalCreateRichTuiFrameProjector(),
    });
  }
}
