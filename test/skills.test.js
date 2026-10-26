import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../server/skills.js';

test('lee name y description simples', () => {
  const fm = parseFrontmatter('---\nname: pdf\ndescription: Trabaja con PDFs\n---\n# Cuerpo');
  assert.equal(fm.name, 'pdf');
  assert.equal(fm.description, 'Trabaja con PDFs');
});

test('admite cadenas con comillas simples escapadas', () => {
  const fm = parseFrontmatter("---\nname: x\ndescription: 'Usa la skill de «Adrián» y ''comillas'''\n---\n");
  assert.equal(fm.description, "Usa la skill de «Adrián» y 'comillas'");
});

test('admite bloques plegados con >', () => {
  const fm = parseFrontmatter('---\nname: y\ndescription: >\n  línea uno\n  línea dos\nlicense: MIT\n---\n');
  assert.equal(fm.description, 'línea uno línea dos');
  assert.equal(fm.license, 'MIT');
});

test('sin frontmatter devuelve objeto vacío', () => {
  assert.deepEqual(parseFrontmatter('# Solo markdown'), {});
});
