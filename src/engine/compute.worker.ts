import { installRenderComputeWorker } from '../renderer/webgl2/computeExecutor';

installRenderComputeWorker({ kind: 'standalone', protocolVersion: 1, sourceId: __SPLATVIEW_ENGINE_SOURCE_ID__ });
