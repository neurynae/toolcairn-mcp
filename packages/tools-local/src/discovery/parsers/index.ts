import type { Ecosystem } from '@toolcairn/types';
import type { Parser } from '../types.js';
import { parseCargo } from './cargo.js';
import { parseComposer } from './composer.js';
import { parseDart } from './dart.js';
import { parseDotnet } from './dotnet.js';
import { parseGo } from './go.js';
import { parseGradle } from './gradle.js';
import { parseMaven } from './maven.js';
import { parseMix } from './mix.js';
import { parseNpm } from './npm.js';
import { parsePypi } from './pypi.js';
import { parseRuby } from './ruby.js';
import { parseSwift } from './swift.js';

export const PARSERS: Record<Ecosystem, Parser> = {
  npm: parseNpm,
  pypi: parsePypi,
  cargo: parseCargo,
  go: parseGo,
  rubygems: parseRuby,
  maven: parseMaven,
  gradle: parseGradle,
  composer: parseComposer,
  hex: parseMix,
  pub: parseDart,
  nuget: parseDotnet,
  'swift-pm': parseSwift,
};

export {
  parseCargo,
  parseComposer,
  parseDart,
  parseDotnet,
  parseGo,
  parseGradle,
  parseMaven,
  parseMix,
  parseNpm,
  parsePypi,
  parseRuby,
  parseSwift,
};
