import { ApiProperty } from "@nestjs/swagger";
import { IsIn } from "class-validator";
import { ROLES } from "@roadland/shared";
import type { Role, UpdateUserRoleRequest } from "@roadland/shared";

export class UpdateUserRoleDto implements UpdateUserRoleRequest {
  @ApiProperty({ description: "변경할 역할", enum: [ROLES.USER, ROLES.ADMIN] })
  @IsIn([ROLES.USER, ROLES.ADMIN])
  role: Role;
}
