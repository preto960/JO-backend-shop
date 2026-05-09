import Pusher from 'pusher';

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID || '2151473',
  key: process.env.PUSHER_KEY || '5c0dab8f11f43914d9a6',
  secret: process.env.PUSHER_SECRET || 'b67b9c3b48f2e0a53646',
  cluster: process.env.PUSHER_CLUSTER || 'us2',
  useTLS: true,
});

export default pusher;

// ─── Helper: emitir evento Pusher con manejo de errores silencioso ──────────
export async function emitPusher(channel, event, data) {
  try {
    await pusher.trigger(channel, event, data);
    console.log(`[Pusher] Event "${event}" emitted to channel "${channel}"`);
  } catch (err) {
    console.error(`[Pusher] Error emitting "${event}" to "${channel}":`, err.message);
  }
}
