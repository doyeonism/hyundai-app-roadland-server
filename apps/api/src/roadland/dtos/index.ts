import { ApiProperty } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import type { AdvanceClockRequest, SubmitTripRequest, TileSegment } from "@template/shared";

import { RULES } from "../domain/rules";

const TILE_ID = /^-?\d{1,7}:-?\d{1,7}$/;

export class TileSegmentDto implements TileSegment {
  @ApiProperty({ description: "타일 ID (q:r)", example: "44406:20068" })
  @Matches(TILE_ID)
  id!: string;

  @ApiProperty() @IsBoolean() hardBrake!: boolean;
  @ApiProperty() @IsBoolean() warning!: boolean;
  @ApiProperty() @IsBoolean() assisted!: boolean;
}

export class SubmitTripDto implements SubmitTripRequest {
  @ApiProperty({ description: "차가 만든 주행 ID(UUID 권장). 재전송해도 한 번만 정산" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  clientTripId!: string;

  @ApiProperty() @IsDateString() startedAt!: string;
  @ApiProperty() @IsDateString() endedAt!: string;

  @ApiProperty() @IsNumber() @Min(0) @Max(2000) km!: number;
  @ApiProperty() @IsNumber() @Min(0) @Max(100) safetyScore!: number;
  @ApiProperty() @IsInt() @Min(0) hardBrakes!: number;
  @ApiProperty() @IsInt() @Min(0) warnings!: number;
  @ApiProperty() @IsInt() @Min(0) laneChanges!: number;
  @ApiProperty() @IsInt() @Min(0) signaledLaneChanges!: number;

  @ApiProperty({ type: [TileSegmentDto] })
  @IsArray()
  @ArrayMaxSize(RULES.maxTilesPerTrip)
  @ValidateNested({ each: true })
  @Type(() => TileSegmentDto)
  tiles!: TileSegmentDto[];
}

export class TileIdParamDto {
  @ApiProperty({ example: "44406:20068" })
  @Matches(TILE_ID)
  id!: string;
}

export class AdvanceClockDto implements AdvanceClockRequest {
  @ApiProperty({ example: 8 })
  @IsNumber()
  @Min(-48)
  @Max(48)
  hours!: number;
}
