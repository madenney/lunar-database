import { pipeline } from "stream";
import { config } from "../config";
import { BytePacer } from "./replayStreams";

/**
 * The one budget for heavy traffic over the server's uplink (~53 Mbit/s): replay
 * downloads and bundle uploads to storage. Their chunks take turns in one queue,
 * so neither starves the other, and whatever the budget leaves stays free for
 * search and page answers. In the 2026-10-08 download-rush test, unpaced bundle
 * uploads filled the uplink and replays started timing out again.
 */
export const uplink = new BytePacer(config.uplinkBytesPerSec);

/** `body` read no faster than the shared budget allows (errors pass through). */
export function paced(body: NodeJS.ReadableStream): NodeJS.ReadableStream {
  const out = uplink.stream();
  pipeline(body, out, () => {
    /* errors reach the consumer through `out` */
  });
  return out;
}
