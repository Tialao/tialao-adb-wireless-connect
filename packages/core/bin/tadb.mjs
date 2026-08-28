#!/usr/bin/env node
// Point d'entree du binaire. Volontairement minuscule : le shebang vit ici, dans un
// fichier .mjs deja en JavaScript, plutot que d'etre injecte dans la sortie de tsc.
import '../dist/cli.js';
