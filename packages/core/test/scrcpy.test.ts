import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { avcCodecFromConfig, generateScid } from '../src/scrcpy.ts';

/** Borne exacte d'un entier signe 32 bits, celle qu'applique Integer.parseInt en Java. */
const JAVA_INT_MAX = 2_147_483_647;

describe('generateScid', () => {
  test('REGRESSION : toujours lisible par Integer.parseInt(s, 16) en Java', () => {
    // Le serveur scrcpy relit le scid comme un entier SIGNE 32 bits. Un tirage sur
    // 32 bits pleins produisait une valeur sur deux au-dela de 2^31 - 1, et le
    // serveur refusait de demarrer sur un NumberFormatException.
    for (let i = 0; i < 5000; i += 1) {
      const scid = generateScid();
      const value = Number.parseInt(scid, 16);
      assert.ok(
        value >= 0 && value <= JAVA_INT_MAX,
        `scid ${scid} vaut ${String(value)}, hors des bornes d'un entier signe 32 bits`,
      );
    }
  });

  test('toujours 8 chiffres hexadecimaux', () => {
    for (let i = 0; i < 500; i += 1) {
      assert.match(generateScid(), /^[0-9a-f]{8}$/);
    }
  });

  test('les petites valeurs sont completees a gauche', () => {
    assert.equal(generateScid(() => 1), '00000001');
    assert.equal(generateScid(() => 0), '00000000');
  });

  test('la borne haute reste acceptable', () => {
    const scid = generateScid(() => JAVA_INT_MAX - 1);
    assert.ok(Number.parseInt(scid, 16) <= JAVA_INT_MAX);
  });

  test('deux tirages successifs different', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateScid()));
    assert.ok(seen.size > 190, 'trop de collisions pour un identifiant de session');
  });
});

describe('avcCodecFromConfig', () => {
  test('extrait la chaine de codec du SPS reellement capture', () => {
    // Capture sur SM-A175F : start code, NAL 0x67 (SPS), puis profil/contraintes/niveau.
    const sps = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x1f, 0xac, 0x1b]);
    assert.equal(avcCodecFromConfig(sps), 'avc1.64001f');
  });

  test('accepte un start code sur 3 octets', () => {
    const sps = new Uint8Array([0x00, 0x00, 0x01, 0x67, 0x42, 0xe0, 0x1e, 0xaa]);
    assert.equal(avcCodecFromConfig(sps), 'avc1.42e01e');
  });

  test('ignore les unites NAL qui ne sont pas un SPS', () => {
    // NAL type 8 (PPS) puis type 7 (SPS) : c'est le second qui compte.
    const data = new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x68, 0xee, 0x3c, 0x80,
      0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x28, 0xac,
    ]);
    assert.equal(avcCodecFromConfig(data), 'avc1.640028');
  });

  test('sans SPS : undefined plutot qu une valeur inventee', () => {
    assert.equal(avcCodecFromConfig(new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x68, 0xee])), undefined);
    assert.equal(avcCodecFromConfig(new Uint8Array([1, 2, 3])), undefined);
  });
});
