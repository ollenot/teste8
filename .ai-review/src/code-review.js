#!/usr/bin/env node
/**
 * code-review.js
 * Chamado pelo hook git pre-push.
 *
 * O git passa as refs do push via stdin, uma por linha:
 *   <local-ref> <local-sha> <remote-ref> <remote-sha>
 *
 * Saída 0  → permite o push
 * Saída 1  → bloqueia o push (somente com BLOCKING_MODE=true ou veredicto REJEITADO)
 */

'use strict';

// Carrega o .env do projeto que está sendo enviado (não do repo CodeReview)
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

// Resolve a raiz do repositório do projeto que está executando o hook
let repoRoot;
try {
  repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
} catch {
  repoRoot = process.cwd();
}

// Carrega dotenv — busca .env na raiz do projeto primeiro, depois na raiz do CodeReview
require('dotenv').config({ path: path.join(repoRoot, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { reviewDiff, parseVerdict } = require('./reviewer');

const BLOCKING_MODE = process.env.BLOCKING_MODE === 'true';
const DIVIDER = '='.repeat(62);

/** Obtém o diff entre o que está sendo enviado e o remoto. */
function getDiff(localSha, remoteSha) {
  try {
    // Se o sha remoto for zeros → branch nova, compara com o commit pai
    const base =
      remoteSha === '0000000000000000000000000000000000000000'
        ? `${localSha}^`
        : remoteSha;

    return execSync(`git diff ${base}..${localSha}`, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      cwd: repoRoot,
    });
  } catch {
    return '';
  }
}

/** Pergunta ao usuário interativamente via TTY (não via stdin, que o git usa). */
function askUser(question) {
  return new Promise((resolve) => {
    // Usa /dev/tty (ou CON no Windows) para não interferir no stdin do git
    const ttyPath = process.platform === 'win32' ? '\\\\.\\CON' : '/dev/tty';
    let ttyStream;
    try {
      const fs = require('fs');
      ttyStream = fs.createReadStream(ttyPath);
    } catch {
      // Fallback: não foi possível abrir o tty, assume "sim"
      resolve('y');
      return;
    }

    const rl = readline.createInterface({ input: ttyStream, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      ttyStream.destroy();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function main() {
  // Lê as refs do push via stdin (fornecidas pelo git)
  const pushRefs = await new Promise((resolve) => {
    const lines = [];
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => { if (line.trim()) lines.push(line.trim()); });
    rl.on('close', () => resolve(lines));
  });

  if (pushRefs.length === 0) {
    process.exit(0);
  }

  // Coleta os diffs de todas as refs sendo enviadas
  let combinedDiff = '';
  for (const line of pushRefs) {
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;

    const [localRef, localSha, remoteRef, remoteSha] = parts;

    // Ignora deleções de branch
    if (localSha === '0000000000000000000000000000000000000000') continue;

    console.log(`  Ref: ${localRef} → ${remoteRef}`);
    combinedDiff += getDiff(localSha, remoteSha);
  }

  if (!combinedDiff.trim()) {
    console.log('[AI Code Review] Nenhuma alteração detectada. Revisão ignorada.\n');
    process.exit(0);
  }

  // Executa o review com IA
  let review;
  try {
    console.log('[AI Code Review] Enviando diff para a IA...\n');
    review = await reviewDiff(combinedDiff);
  } catch (err) {
    console.error(`[AI Code Review] ERRO: ${err.message}`);
    console.log('[AI Code Review] O push prosseguirá mesmo com a falha no review.\n');
    process.exit(0);
  }

  // Exibe os resultados
  console.log(DIVIDER);
  console.log('  RESULTADO DO AI CODE REVIEW');
  console.log(DIVIDER);
  console.log(review);
  console.log(DIVIDER);

  const verdict = parseVerdict(review);
  const verdictLabel =
    verdict === 'APROVADO'
      ? '✔  APROVADO'
      : verdict === 'REQUER_ALTERAÇÕES'
      ? '⚠  REQUER ALTERAÇÕES'
      : verdict === 'REJEITADO'
      ? '✖  REJEITADO'
      : '?  DESCONHECIDO';

  console.log(`\n  Veredicto: ${verdictLabel}`);

  // --- Decide se bloqueia o push ---
  if (verdict === 'REJEITADO' && BLOCKING_MODE) {
    console.log('\n[AI Code Review] Push BLOQUEADO (BLOCKING_MODE=true, veredicto=REJEITADO).');
    console.log('  Corrija os problemas acima e tente novamente.');
    console.log('  Use "git push --no-verify" para ignorar.\n');
    process.exit(1);
  }

  if (verdict === 'REQUER_ALTERAÇÕES' || verdict === 'REJEITADO') {
    const answer = await askUser('\n[AI Code Review] Problemas encontrados. Fazer push mesmo assim? (s/N): ');
    if (answer !== 's' && answer !== 'sim') {
      console.log('[AI Code Review] Push cancelado pelo usuário.\n');
      process.exit(1);
    }
  }

  console.log('\n[AI Code Review] Prosseguindo com o push...\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('[AI Code Review] Erro inesperado:', err);
  process.exit(0); // Não bloqueia o push em caso de erros inesperados
});
