import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import type { OpsSessionInfo } from "../domain/clients.js";
import { OpsConsoleError } from "../domain/errors.js";
import { OPS_PERMISSIONS_KEY } from "./ops-auth.decorator.js";
import { OpsConsoleHttpService } from "./ops-console-http.service.js";
import { csrfSatisfied, resolveOpsCredential } from "./ops-session-cookie.js";

@Injectable()
export class OpsAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly opsConsoleHttpService: OpsConsoleHttpService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions =
      this.reflector.getAllAndOverride<string[]>(OPS_PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass()
      ]) ?? [];

    const request = context.switchToHttp().getRequest<{
      method: string;
      headers: Record<string, string | string[] | undefined>;
      opsSession?: OpsSessionInfo;
      opsSessionToken?: string;
    }>();
    const credential = resolveOpsCredential(request.headers);
    if (!credential) {
      throw new UnauthorizedException("Missing ops session token");
    }
    if (credential.source === "cookie" && !csrfSatisfied(request.method, request.headers)) {
      throw new ForbiddenException("Missing or invalid CSRF token");
    }
    const token = credential.token;
    request.opsSessionToken = token;

    let session: OpsSessionInfo;

    try {
      session = await this.opsConsoleHttpService.getCurrentSession(token);
    } catch (error) {
      if (error instanceof OpsConsoleError && error.statusCode === 401) {
        throw new UnauthorizedException(error.message);
      }

      if (error instanceof OpsConsoleError && error.statusCode === 403) {
        throw new ForbiddenException(error.message);
      }

      throw error;
    }

    const missingPermissions = requiredPermissions.filter(
      (permission) => !session.permissions.includes(permission)
    );
    if (missingPermissions.length > 0) {
      throw new ForbiddenException(
        `Ops session is missing permissions: ${missingPermissions.join(", ")}`
      );
    }

    request.opsSession = session;
    return true;
  }
}
