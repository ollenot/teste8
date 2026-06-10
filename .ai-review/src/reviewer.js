/**
 * reviewer.js
 * Lógica central de review com IA — compartilhada pelo hook pre-push e pelo GitHub Actions.
 */

'use strict';

const { OpenAI } = require('openai');

const REVIEW_PROMPT = `Você é um engenheiro de software sênior realizando uma revisão de código detalhada.
Analise o git diff abaixo e forneça feedback estruturado.
Responda SEMPRE em português do Brasil (pt-BR), sem exceções.

Analise com foco em:
- Bugs e erros de lógica
- Vulnerabilidades de segurança (OWASP Top 10: injeção, XSS, autenticação quebrada, desserialização insegura, etc.)
- Problemas de desempenho
- Qualidade, legibilidade e manutenibilidade do código
- Tratamento de erros ausente ou incorreto
- Violações dos princípios SOLID e boas práticas
- Segredos, credenciais ou dados sensíveis expostos no código

Formate sua resposta EXATAMENTE assim (mantenha os cabeçalhos das seções):

## Resumo
[Avaliação geral em um parágrafo]

## Problemas Encontrados
[Liste cada problema. Se não houver, escreva "Nenhum problema significativo encontrado."]
- [CRÍTICO] arquivo:linha — descrição
- [ALTO] arquivo:linha — descrição
- [MÉDIO] arquivo:linha — descrição
- [BAIXO] arquivo:linha — descrição

## Recomendações
[Lista com as melhorias mais importantes]

## Veredicto
[Escreva exatamente um dos valores: APROVADO | REQUER_ALTERAÇÕES | REJEITADO]
- APROVADO: código está bom, apenas problemas menores ou nenhum
- REQUER_ALTERAÇÕES: há problemas que devem ser corrigidos, mas não bloqueiam
- REJEITADO: bugs críticos ou vulnerabilidades de segurança que devem ser corrigidos antes do merge

Git diff:
\`\`\`
{DIFF}
\`\`\`
`;

/**
 * Envia um diff para a IA e retorna o texto do review.
 * @param {string} diff - Conteúdo do git diff.
 * @param {object} options - { apiKey, model, maxDiffSize, azureEndpoint, azureDeployment }
 * @returns {Promise<string>} Texto do review.
 */
async function reviewDiff(diff, options = {}) {
  const {
    apiKey = process.env.OPENAI_API_KEY,
    model = process.env.AI_MODEL || 'llama-3.3-70b-versatile',
    maxDiffSize = parseInt(process.env.MAX_DIFF_SIZE || '12000', 10),
    azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT,
    azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT,
    azureApiKey = process.env.AZURE_OPENAI_API_KEY,
    groqApiKey = process.env.GROQ_API_KEY,
  } = options;

  // Seleciona o provedor (prioridade: Groq → Azure → OpenAI)
  let client;
  let resolvedModel = model;

  if (groqApiKey) {
    // Groq — plano gratuito, API compatível com OpenAI
    client = new OpenAI({
      apiKey: groqApiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    });
  } else if (azureEndpoint && azureApiKey) {
    // Azure OpenAI
    const { AzureOpenAI } = require('openai');
    client = new AzureOpenAI({
      apiKey: azureApiKey,
      endpoint: azureEndpoint,
      apiVersion: '2024-02-01',
    });
    resolvedModel = azureDeployment || 'gpt-4o';
  } else if (apiKey) {
    // OpenAI padrão
    client = new OpenAI({ apiKey });
  } else {
    throw new Error(
      'Nenhuma credencial de IA encontrada.\n' +
        'Defina GROQ_API_KEY (gratuito: https://console.groq.com) ou OPENAI_API_KEY no arquivo .env.\n' +
        'Consulte .env.example para detalhes.'
    );
  }

  // Trunca o diff para não exceder o limite de tokens
  const truncated =
    diff.length > maxDiffSize
      ? diff.substring(0, maxDiffSize) +
        `\n\n... [diff truncado em ${maxDiffSize} caracteres para não exceder o limite de tokens]`
      : diff;

  const prompt = REVIEW_PROMPT.replace('{DIFF}', truncated);

  const response = await client.chat.completions.create({
    model: resolvedModel,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 2048,
    temperature: 0.2, // Temperatura baixa = resposta mais determinística e factual
  });

  return response.choices[0].message.content.trim();
}

/**
 * Extrai o veredicto do texto do review.
 * @param {string} review
 * @returns {'APROVADO'|'REQUER_ALTERAÇÕES'|'REJEITADO'|'DESCONHECIDO'}
 */
function parseVerdict(review) {
  const match = review.match(/##\s*Veredicto\s*\n+([A-ZÇÃÕ_]+)/i);
  if (!match) return 'DESCONHECIDO';
  const v = match[1].trim().toUpperCase();
  if (['APROVADO', 'REQUER_ALTERAÇÕES', 'REJEITADO'].includes(v)) return v;
  return 'DESCONHECIDO';
}

module.exports = { reviewDiff, parseVerdict };
