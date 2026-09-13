import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createProducerViewStore, PRODUCER_VIEW_EVENT } from './producer-view.js';
import { registerJunctionCommand } from './command.js';
import { registerJunctionLifecycle } from './lifecycle.js';

export default function (pi: ExtensionAPI): void {
  const producerViews = createProducerViewStore();
  let observeSession = () => {};
  pi.events.on(PRODUCER_VIEW_EVENT, (value) => {
    observeSession();
    producerViews.accept(value);
  });
  registerJunctionCommand(pi);
  observeSession = registerJunctionLifecycle(pi, { producerViews });
}
