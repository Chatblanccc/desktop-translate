import { pathToFileURL } from 'node:url';

import {
  POC_RESEARCH_SCOPE,
  PocError,
  resolveArtifactOutput,
  sha256Text,
  writeJsonArtifact
} from './lib.mjs';
import { serializeJsonArtifact } from './bergamot-generation-lib.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const subjects = Object.freeze([
  ['The desktop translator', '桌面翻译器'],
  ['The installer', '安装程序'],
  ['The local model', '本地模型'],
  ['The update service', '更新服务'],
  ['The settings page', '设置页面'],
  ['The floating ball', '悬浮球'],
  ['The translation host', '翻译主机'],
  ['The model manager', '模型管理器'],
  ['The result card', '结果卡片'],
  ['The offline engine', '离线引擎']
]);
const scenarios = Object.freeze([
  {
    tag: 'offline',
    pair: (subjectEn, subjectZh, number) => [
      `${subjectEn} completed test ${number} without accessing the internet.`,
      `${subjectZh}在未访问互联网的情况下完成了测试 ${number}。`
    ]
  },
  {
    tag: 'settings',
    pair: (subjectEn, subjectZh, number) => [
      `${subjectEn} saved configuration ${number} after validation.`,
      `${subjectZh}在验证后保存了配置 ${number}。`
    ]
  },
  {
    tag: 'latency',
    pair: (subjectEn, subjectZh, number) => [
      `${subjectEn} loaded the local model in ${number} milliseconds.`,
      `${subjectZh}在 ${number} 毫秒内加载了本地模型。`
    ]
  },
  {
    tag: 'path-safety',
    pair: (subjectEn, subjectZh, number) => [
      `${subjectEn} rejected unsafe path ${number} before writing files.`,
      `${subjectZh}在写入文件前拒绝了不安全路径 ${number}。`
    ]
  },
  {
    tag: 'recovery',
    pair: (subjectEn, subjectZh, number) => [
      `${subjectEn} restored checkpoint ${number} after the restart.`,
      `${subjectZh}在重启后恢复了检查点 ${number}。`
    ]
  },
  {
    tag: 'user-data',
    pair: (subjectEn, subjectZh, number) => [
      `${subjectEn} kept the user database after uninstall attempt ${number}.`,
      `${subjectZh}在第 ${number} 次卸载尝试后保留了用户数据库。`
    ]
  },
  {
    tag: 'privacy',
    pair: (subjectEn, subjectZh, number) => [
      `${subjectEn} reported error code ${number} without raw user text.`,
      `${subjectZh}报告了错误代码 ${number}，但未包含用户原文。`
    ]
  },
  {
    tag: 'process',
    pair: (subjectEn, subjectZh, number) => [
      `${subjectEn} closed all helper processes in ${number} seconds.`,
      `${subjectZh}在 ${number} 秒内关闭了所有辅助进程。`
    ]
  },
  {
    tag: 'integrity',
    pair: (subjectEn, subjectZh, number) => [
      `${subjectEn} verified package hash ${number} before launch.`,
      `${subjectZh}在启动前验证了软件包哈希 ${number}。`
    ]
  },
  {
    tag: 'retry',
    pair: (subjectEn, subjectZh, number) => [
      `${subjectEn} retried task ${number} after a recoverable failure.`,
      `${subjectZh}在可恢复故障后重试了任务 ${number}。`
    ]
  },
  {
    tag: 'display',
    pair: (subjectEn, subjectZh, number) => [
      `${subjectEn} displayed result ${number} on the primary monitor.`,
      `${subjectZh}在主显示器上显示了结果 ${number}。`
    ]
  },
  {
    tag: 'interaction',
    pair: (subjectEn, subjectZh, number) => [
      `${subjectEn} moved the floating ball to position ${number}.`,
      `${subjectZh}把悬浮球移动到了位置 ${number}。`
    ]
  },
  {
    tag: 'cpu',
    pair: (subjectEn, subjectZh, number) => [
      `${subjectEn} finished offline request ${number} using only the CPU.`,
      `${subjectZh}仅使用 CPU 完成了离线请求 ${number}。`
    ]
  },
  {
    tag: 'network',
    pair: (subjectEn, subjectZh, number) => [
      `${subjectEn} kept the network request count at zero during trial ${number}.`,
      `${subjectZh}在试验 ${number} 期间将网络请求数保持为零。`
    ]
  },
  {
    tag: 'persistence',
    pair: (subjectEn, subjectZh, number) => [
      `${subjectEn} preserved setting ${number} across the restart.`,
      `${subjectZh}在重启前后保留了设置 ${number}。`
    ]
  },
  {
    tag: 'cleanup',
    pair: (subjectEn, subjectZh, number) => [
      `${subjectEn} removed temporary stage ${number} after success.`,
      `${subjectZh}在成功后移除了临时阶段目录 ${number}。`
    ]
  },
  {
    tag: 'deduplication',
    pair: (subjectEn, subjectZh, number) => [
      `${subjectEn} refused duplicate generation item ${number}.`,
      `${subjectZh}拒绝了重复的生成条目 ${number}。`
    ]
  },
  {
    tag: 'memory',
    pair: (subjectEn, subjectZh, number) => [
      `${subjectEn} measured the working set for process trial ${number}.`,
      `${subjectZh}测量了进程试验 ${number} 的工作集。`
    ]
  },
  {
    tag: 'license',
    pair: (subjectEn, subjectZh, number) => [
      `${subjectEn} validated license record ${number} before the research run.`,
      `${subjectZh}在研究运行前验证了许可证记录 ${number}。`
    ]
  },
  {
    tag: 'gate-a',
    pair: (subjectEn, subjectZh, number) => [
      `${subjectEn} marked candidate ${number} as awaiting the user decision.`,
      `${subjectZh}把候选项 ${number} 标记为等待用户决定。`
    ]
  }
]);

export function buildSelfAuthoredGateADataset(direction, snapshotId) {
  if (!['en-zh', 'zh-en'].includes(direction)
      || !SAFE_ID.test(snapshotId ?? '')) {
    throw new PocError('GATE_A_DATASET_ARGUMENT_INVALID');
  }
  const records = [];
  for (let subjectIndex = 0; subjectIndex < subjects.length; subjectIndex += 1) {
    const [subjectEn, subjectZh] = subjects[subjectIndex];
    for (let scenarioIndex = 0;
      scenarioIndex < scenarios.length;
      scenarioIndex += 1) {
      const number = (subjectIndex * scenarios.length) + scenarioIndex + 1;
      let [english, chinese] = scenarios[scenarioIndex].pair(
        subjectEn,
        subjectZh,
        number
      );
      const tags = ['self-authored', scenarios[scenarioIndex].tag];
      if (number === 1) {
        english = 'During the Phase Seven verification in Shanghai, '
          + 'Desktop Translate completed its first offline test without '
          + 'contacting a cloud service.';
        chinese = '在上海进行 Phase Seven 验证期间，Desktop Translate '
          + '在未连接云服务的情况下完成了第一次离线测试。';
        tags.push('proper-noun');
      } else if (number === 2) {
        english = 'After validating every local configuration value, the '
          + 'desktop translator saved the settings, restarted its isolated '
          + 'translation process, restored the previous window position, '
          + 'and completed another offline request without losing the '
          + 'user-selected language direction.';
        chinese = '桌面翻译器验证了每个本地配置值后保存设置，随后重启隔离的翻译进程，'
          + '恢复先前的窗口位置，并在不丢失用户所选语言方向的情况下完成了另一次离线请求。';
        tags.push('long-sentence');
      }
      records.push({
        itemId: `${direction}-self-${String(number).padStart(3, '0')}`,
        direction,
        source: direction === 'en-zh' ? english : chinese,
        reference: direction === 'en-zh' ? chinese : english,
        tags
      });
    }
  }
  if (records.length !== 200
      || new Set(records.map((record) => record.source)).size !== 200) {
    throw new PocError('GATE_A_DATASET_INTERNAL_CARDINALITY_INVALID');
  }
  return {
    schemaVersion: 'phase7-gate-a-self-authored-dataset-v1',
    status: 'SELF_AUTHORED_SYNTHETIC_DATASET_FROZEN',
    scope: POC_RESEARCH_SCOPE,
    datasetId: 'phase7-self-authored-desktop-operations-v2',
    snapshotId,
    licenseExpression: 'SELF-AUTHORED-FOR-PHASE7-RESEARCH',
    contentDeclaration: 'NO_USER_HISTORY_NO_CLIPBOARD_NO_PRIVATE_CORPUS',
    containsPersonalData: false,
    usageAuthorization: 'AUTHORIZED_FOR_PHASE7_HUMAN_EVALUATION',
    records
  };
}

async function main(argv) {
  const options = parseArguments(argv);
  const enZh = buildSelfAuthoredGateADataset('en-zh', options.snapshotId);
  const zhEn = buildSelfAuthoredGateADataset('zh-en', options.snapshotId);
  await writeJsonArtifact(resolveArtifactOutput(options.enZhOutput), enZh);
  await writeJsonArtifact(resolveArtifactOutput(options.zhEnOutput), zhEn);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 'phase7-gate-a-dataset-generation-summary-v1',
    status: 'SELF_AUTHORED_SYNTHETIC_DATASET_CREATED',
    snapshotId: options.snapshotId,
    directions: [
      {
        direction: 'en-zh',
        recordCount: enZh.records.length,
        artifactSha256: sha256Text(serializeJsonArtifact(enZh))
      },
      {
        direction: 'zh-en',
        recordCount: zhEn.records.length,
        artifactSha256: sha256Text(serializeJsonArtifact(zhEn))
      }
    ],
    rawTextEmittedInSummary: false,
    integrationOrDistributionAuthorized: false
  }, null, 2)}\n`);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--snapshot-id', '--en-zh-output', '--zh-en-output'].includes(key)
        || !value
        || value.startsWith('--')
        || values.has(key)) {
      throw new PocError('GATE_A_DATASET_CLI_ARGUMENT_INVALID');
    }
    values.set(key, value);
  }
  const snapshotId = values.get('--snapshot-id');
  const enZhOutput = values.get('--en-zh-output');
  const zhEnOutput = values.get('--zh-en-output');
  if (values.size !== 3
      || !SAFE_ID.test(snapshotId ?? '')
      || !enZhOutput
      || !zhEnOutput
      || enZhOutput === zhEnOutput) {
    throw new PocError('GATE_A_DATASET_CLI_ARGUMENT_REQUIRED');
  }
  return { snapshotId, enZhOutput, zhEnOutput };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.code ?? error.message}\n`);
    process.exitCode = 1;
  });
}
