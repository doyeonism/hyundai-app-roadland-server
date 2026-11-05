"use client";

import React from "react";
import { LogOut } from "lucide-react";

import { useLogout } from "../model/useLogout";

interface LogoutButtonProps {
  className?: string;
}

export function LogoutButton({ className }: LogoutButtonProps) {
  const logout = useLogout();

  return (
    <button
      type='button'
      onClick={() => logout.mutate()}
      disabled={logout.isPending}
      className={className}
    >
      <LogOut className='w-4 h-4' />
      {logout.isPending ? "로그아웃 중..." : "로그아웃"}
    </button>
  );
}
