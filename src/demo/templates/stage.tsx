// The kit's Stage with label layout: every template draws through this, so no template label is
// clipped by the stage edge or collides with another one (see layout.ts).

import { Stage as KitStage, type StageProps } from "../kit";
import { laidOut } from "./layout";

export function Stage(props: StageProps) {
  return <KitStage {...props} onFrame={laidOut(props.onFrame)} />;
}
