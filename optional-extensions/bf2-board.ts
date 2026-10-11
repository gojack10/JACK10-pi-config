import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installReceiver } from '../extensions/bf2-swarm/receiver.mjs';

export default function (pi: ExtensionAPI) {
  installReceiver(pi);
}
