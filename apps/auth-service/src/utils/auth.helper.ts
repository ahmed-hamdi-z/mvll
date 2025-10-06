import { NextFunction } from "express";
import { ValidationError } from "../../../../packages/error-handler";
import crypto from "crypto";
import redis from "../../../../packages/libs/redis";
import { sendEmail } from "./sendMail";

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const validateRegistrationData = (
  data: any,
  userType: "user" | "seller"
) => {
  const { name, email, password, phone_number, country } = data;

  if (
    !name ||
    !email ||
    !password ||
    (userType === "seller" && (!phone_number || !country))
  ) {
    throw new ValidationError("All fields are required");
  }

  if (!emailRegex.test(email)) {
    throw new ValidationError("Invalid email format");
  }
};

export const checkOtpRestrictions = async (
  email: string,
  next: NextFunction
) => {
  if (await redis.get(`otp_lock:${email}`)) {
    return next(
      new ValidationError("Account is locked. Please try again 30 minutes.")
    );
  }

  if (await redis.get(`otp_spam_lock:${email}`)) {
    return next(
      new ValidationError(
        "Too many OTP requests! Please wait 1 hour before retry."
      )
    );
  }

  if (await redis.get(`otp_cooldown:${email}`)) {
    return next(
      new ValidationError(
        "Please wait 1 miniute before requesting another OTP."
      )
    );
  }
};

export const sendOtp = async (
  name: string,
  email: string,
  template: string
) => {
  const otp = crypto.randomInt(1000, 9999).toString();
  await sendEmail(email, "Verify Your Email", template, {
    name,
    otp,
  });
  await redis.set(`otp:${email}`, otp, "EX", 300);
  await redis.set(`otp_cooldown:${email}`, "true", "EX", 60);
};

export const trackOtpRequests = async (email: string, next: NextFunction) => {
  const otpRequestsKey = `otp_request_count:${email}`;

  let otpRequests = parseInt((await redis.get(otpRequestsKey)) || "0");

  if (otpRequests >= 2) {
    await redis.set(`otp_spam_lock:${email}`, "locked", "EX", 3600);
    return next(
      new ValidationError(
        "Too many OTP requests! Please try again later after 1 hour."
      )
    );
  }
  await redis.set(otpRequestsKey, otpRequests + 1, "EX", 3600);
};

export const verifyOtp = async (
  email: string,
  otp: string,
  next: NextFunction
) => {
  const storedOtp = await redis.get(`otp:${email}`);
  if (!storedOtp) {
    throw next(new ValidationError("Invalid OTP Or Expired!"));
  }

  const failedAttempsKey = `otp_attempts:${email}`;
  const failedAttempts = parseInt((await redis.get(failedAttempsKey)) || "0");

  if (storedOtp !== otp) {
    if (failedAttempts >= 2) {
      await redis.set(`otp_lock:${email}`, "locked", "EX", 1800);
      await redis.del(`otp:${email}`, failedAttempsKey);
      throw next(
        new ValidationError(
          "Account is locked. Please try again in 30 minutes."
        )
      );
    }
    await redis.set(failedAttempsKey, failedAttempts + 1, "EX", 3600);
    throw next(
      new ValidationError(
        `Incorrect OTP. You have ${2 - failedAttempts} attempts left.`
      )
    );
  }
  await redis.del(`otp:${email}`, failedAttempsKey);
};
