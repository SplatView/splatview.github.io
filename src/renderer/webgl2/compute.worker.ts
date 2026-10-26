import { BUILD_DESCRIPTOR } from '../../generated/buildIdentity';
import { installRenderComputeWorker } from './computeExecutor';

installRenderComputeWorker({ kind: 'application', build: BUILD_DESCRIPTOR });
