// Keep reader exports; only the selected floor opens through its approved runtime.
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleURL = (code, name) => {
  if (!code) return new URL(name, import.meta.url);
  if (!isAbsolute(code) || /[\0\n\r]/.test(code)) throw Error('factory source root must be an absolute path');
  return pathToFileURL(join(code, 'extensions/dark-factory/floors', name));
};
const readerCode = process.env.FACTORY_READER_CODE;
const controllerCode = process.env.FACTORY_CONTROLLER_CODE;
const [reader, approved, supervisor, room] = await Promise.all([
  import(moduleURL(readerCode, 'runtime.mjs')),
  import(moduleURL(controllerCode, 'runtime.mjs')),
  import(moduleURL(controllerCode, 'supervisor.mjs')),
  import(moduleURL(process.env.FACTORY_ROOM_CODE ?? readerCode, 'room.mjs')),
]);
const controllerFloor = process.env.FACTORY_CONTROLLER_FLOOR ?? 'core';
export const ensureController = supervisor.ensureFloorController;
export const serveFloors = room.serveFloors;
export const runtime = {
  ...reader,
  openFloor: (id, options) => (id === controllerFloor ? approved : reader).openFloor(id, options),
};
