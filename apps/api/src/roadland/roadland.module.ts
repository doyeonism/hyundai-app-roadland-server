import { Module } from "@nestjs/common";

import { CarDevController } from "./controllers/car-dev.controller";
import { CarController } from "./controllers/car.controller";
import { VehicleGuard } from "./guards/vehicle.guard";
import { ClockService } from "./services/clock.service";
import { DemoService } from "./services/demo.service";
import { GameService } from "./services/game.service";
import { RankingService } from "./services/ranking.service";
import { VehicleAuthService } from "./services/vehicle-auth.service";
import { VehicleLockService } from "./services/vehicle-lock.service";

// 로드랜드 차량 게임 API (v1/car). RedisService 는 전역 모듈에서 주입된다.
@Module({
  controllers: [CarController, CarDevController],
  providers: [
    GameService,
    VehicleAuthService,
    VehicleLockService,
    ClockService,
    RankingService,
    DemoService,
    VehicleGuard,
  ],
})
export class RoadlandModule {}
