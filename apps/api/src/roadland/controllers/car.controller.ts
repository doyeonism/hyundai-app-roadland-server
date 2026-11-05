import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";

import { Public } from "../../shared/decorators/public.decorator";
import { ResponseMessage } from "../../shared/decorators/response-message.decorator";
import { SubmitTripDto, TileIdParamDto } from "../dtos";
import { VehicleGuard, VehicleId } from "../guards/vehicle.guard";
import { CAR_ROUTES } from "../routes";
import { GameService } from "../services/game.service";
import { VehicleAuthService } from "../services/vehicle-auth.service";

const R = CAR_ROUTES.v1;

// 차량 앱 전용 API. 사용자 JWT 대신 차량 기기 토큰으로 인증한다(@Public + VehicleGuard).
@ApiTags("Roadland Car")
@Public()
@Controller(R.BASE)
export class CarController {
  constructor(
    private readonly game: GameService,
    private readonly auth: VehicleAuthService,
  ) {}

  @Post(R.DEVICES)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: "차량 기기 등록(토큰 발급)" })
  @ResponseMessage("차량이 등록되었습니다.")
  register() {
    return this.auth.register();
  }

  @Get(R.HOME)
  @UseGuards(VehicleGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "홈 요약(크레딧·방치 수익·오늘 주행)" })
  home(@VehicleId() vehicleId: string) {
    return this.game.home(vehicleId);
  }

  @Post(R.TRIPS)
  @UseGuards(VehicleGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "주행 정산. 같은 clientTripId 는 처음 결과를 돌려준다" })
  @ResponseMessage("주행이 정산되었습니다.")
  submitTrip(@VehicleId() vehicleId: string, @Body() dto: SubmitTripDto) {
    return this.game.submitTrip(vehicleId, dto);
  }

  @Get(R.TERRITORY)
  @UseGuards(VehicleGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "지나간 땅·내 땅·특별 구간" })
  territory(@VehicleId() vehicleId: string) {
    return this.game.territory(vehicleId);
  }

  @Post(R.BUY)
  @HttpCode(HttpStatus.OK)
  @UseGuards(VehicleGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "땅 구매" })
  @ResponseMessage("땅을 샀어요.")
  buy(@VehicleId() vehicleId: string, @Param() { id }: TileIdParamDto) {
    return this.game.buy(vehicleId, id);
  }

  @Post(R.UPGRADE)
  @HttpCode(HttpStatus.OK)
  @UseGuards(VehicleGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "땅 업그레이드(쌓인 수익은 먼저 받는다)" })
  @ResponseMessage("땅을 올렸어요.")
  upgrade(@VehicleId() vehicleId: string, @Param() { id }: TileIdParamDto) {
    return this.game.upgrade(vehicleId, id);
  }

  @Post(R.COLLECT)
  @HttpCode(HttpStatus.OK)
  @UseGuards(VehicleGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "방치 수익 한 번에 받기" })
  collect(@VehicleId() vehicleId: string) {
    return this.game.collect(vehicleId);
  }

  @Get(R.RECORDS)
  @UseGuards(VehicleGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "안전 기록·특별 구간 수집" })
  records(@VehicleId() vehicleId: string) {
    return this.game.records(vehicleId);
  }

  @Get(R.RANKING)
  @UseGuards(VehicleGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "땅 점수·주간 주행 랭킹" })
  ranking(@VehicleId() vehicleId: string) {
    return this.game.rankings(vehicleId);
  }
}
