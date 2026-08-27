import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createProducerBoardStore, PRODUCER_BOARD_EVENT } from './producer-board.js';
import { registerJunctionCommand } from './command.js';
import { registerJunctionLifecycle } from './lifecycle.js';

export default function (pi: ExtensionAPI): void {
  const producerBoards = createProducerBoardStore();
  pi.events.on(PRODUCER_BOARD_EVENT, (value) => {
    producerBoards.accept(value);
  });
  registerJunctionCommand(pi);
  registerJunctionLifecycle(pi);
}
