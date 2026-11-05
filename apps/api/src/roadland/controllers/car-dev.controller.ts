import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { Public } from "../../shared/decorators/public.decorator";
import { AdvanceClockDto } from "../dtos";
import { DevToolsGuard } from "../guards/vehicle.guard";
import { CAR_ROUTES } from "../routes";
import { DemoService } from "../services/demo.service";

const R = CAR_ROUTES.v1;

// 시연·개발 도구. ROADLAND_DEV_TOOLS=true 가 아니면 모든 라우트가 404 다.
@ApiTags("Roadland Dev")
@Public()
@UseGuards(DevToolsGuard)
@Controller(R.DEV_BASE)
export class CarDevController {
  constructor(private readonly demo: DemoService) {}

  @Get(R.DEV_VEHICLES)
  @ApiOperation({ summary: "최근 등록 차량" })
  vehicles() {
    return this.demo.vehicles();
  }

  @Post(R.DEV_ADVANCE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "이 차량의 게임 시계를 앞당긴다" })
  advance(@Param("vehicleId", ParseUUIDPipe) vehicleId: string, @Body() dto: AdvanceClockDto) {
    return this.demo.advance(vehicleId, dto.hours);
  }

  @Post(R.DEV_RESET)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "처음 등록한 상태로 되돌리기" })
  reset(@Param("vehicleId", ParseUUIDPipe) vehicleId: string) {
    return this.demo.reset(vehicleId);
  }

  @Post(R.DEV_SEED)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "시연 기록(출근길·내 땅·안전 점수) 채우기" })
  seed(@Param("vehicleId", ParseUUIDPipe) vehicleId: string) {
    return this.demo.seed(vehicleId);
  }

  @Delete(R.DEV_REMOVE)
  @ApiOperation({ summary: "차량 삭제" })
  remove(@Param("vehicleId", ParseUUIDPipe) vehicleId: string) {
    return this.demo.remove(vehicleId);
  }

  @Get(R.DEV_ROUTE)
  @ApiOperation({ summary: "시연 출근길 좌표" })
  route() {
    return this.demo.route();
  }
}
