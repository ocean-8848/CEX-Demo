import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata
} from "@nestjs/common";

import type { OpsSessionInfo } from "../domain/clients.js";

export const OPS_PERMISSIONS_KEY = "ops_permissions";

export const RequireOpsPermissions = (...permissions: string[]) =>
  SetMetadata(OPS_PERMISSIONS_KEY, permissions);

export const CurrentOpsSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): OpsSessionInfo | undefined => {
    const request = context
      .switchToHttp()
      .getRequest<{ opsSession?: OpsSessionInfo }>();

    return request.opsSession;
  }
);
