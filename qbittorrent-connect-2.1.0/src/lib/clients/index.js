// Registre des clients torrent pris en charge.
import { QBittorrent } from './qbittorrent.js';
import { Transmission } from './transmission.js';
import { Deluge } from './deluge.js';
import { RTorrent } from './rtorrent.js';
import { UTorrent } from './utorrent.js';
import { Synology } from './synology.js';
import { Flood } from './flood.js';
import { Aria2 } from './aria2.js';

export { ClientError } from './base.js';

export const CLIENTS = [QBittorrent, Transmission, Deluge, RTorrent, UTorrent, Synology, Flood, Aria2];

export const clientMeta = (id) => (CLIENTS.find((c) => c.meta.id === id) || QBittorrent).meta;
export const clientCaps = (id) => (CLIENTS.find((c) => c.meta.id === id) || QBittorrent).caps;

export function createClient(cfg) {
  const Client = CLIENTS.find((c) => c.meta.id === cfg.client) || QBittorrent;
  return new Client(cfg);
}
