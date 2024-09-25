import { conn } from './db/conn.js';
import { populateDB } from './services/populate.js';

const simpleCollections = [
  '_m_conjuntosLocaisComRegioes',
  '_m_gruposProdutos',
  '_m_locaisComRegioes',
  '_m_snapshotConjuntosLocais',
  '_sep_agrupamentosPredios',
  '_sep_circuitos',
  '_sep_dicionarioCidades',
  '_sep_predios',
  'arquivos',
  'auditoria',
  'briefings',
  'campanhas',
  'cidades',
  'conjuntosLocais',
  'contas',
  'empresas',
  'faixasPlanejamentoRegioes',
  'fila-simulacoes',
  'funcionalidadesControladas',
  'gruposProdutos',
  'imagens',
  'locais',
  'log',
  'logs',
  'metricas',
  'municipios-db',
  'notificacoes',
  'pacotes',
  'parametrosEletroads',
  'planosPredefinidos',
  'precificacoes',
  'produtosDesconsiderados',
  'regioesReal',
  'retoolSessao',
  'sep_sincronizacao',
  'skus',
  'targetsReal',
  'targetsUniversos',
  'uploadMidia',
  'usuarios',
  'usuariosContas',
  'simulacoesPlanejamento',
  'simulacoesPlanejamentoGeohashes',
  'simulacoesPlanejamentoLocais',
  'planoMidia',
  'planoMidiaLocais',
  'planoMidiaTracking',
  'planoMidiaVersoes',
  'mediaplans',
];
const complexCollections = ['dados', 'snapshotDados'];

const main = async () => {
  const client = await conn();
  const db = client.db('myDB');

  const options = {
    simpleCollections: simpleCollections,
    complexCollections: complexCollections,
    collectionSize: 5e5,
    batchSize: 2500,
    db,
    concurrence: 2,
  };

  await populateDB(options);
  client.close();
};

await main();
