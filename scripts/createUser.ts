import "reflect-metadata";
import { AppDataSource } from "../src/db/dataSource";
import { User, UserRole } from "../src/entities/User";
import { hashPassword } from "../src/services/auth.service";

/**
 * Creates a web user, or resets the password if the email exists.
 *
 *   npm run create-user -- <email> <password> [name] [role]
 */
async function main(): Promise<void> {
  const [email, password, name, role] = process.argv.slice(2);

  if (!email || !password) {
    console.error("usage: npm run create-user -- <email> <password> [name] [role: viewer|admin]");
    process.exit(1);
  }
  if (password.length < 10) {
    console.error("รหัสผ่านต้องยาวอย่างน้อย 10 ตัวอักษร");
    process.exit(1);
  }
  if (role && role !== "viewer" && role !== "admin") {
    console.error("role ต้องเป็น viewer หรือ admin");
    process.exit(1);
  }

  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(User);

  const existing = await repo
    .createQueryBuilder("u")
    .where("lower(u.email) = lower(:email)", { email })
    .getOne();

  const passwordHash = await hashPassword(password);

  if (existing) {
    existing.passwordHash = passwordHash;
    if (name) existing.name = name;
    if (role) existing.role = role as UserRole;
    existing.isActive = true;
    await repo.save(existing);
    console.log(`อัปเดตรหัสผ่านของ ${existing.email} (role=${existing.role}) แล้ว`);
  } else {
    const user = await repo.save(
      repo.create({
        email,
        passwordHash,
        name: name ?? null,
        role: (role as UserRole) ?? "viewer",
        isActive: true,
      })
    );
    console.log(`สร้างผู้ใช้ ${user.email} (id=${user.id}, role=${user.role}) แล้ว`);
  }

  await AppDataSource.destroy();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await AppDataSource.destroy().catch(() => undefined);
  process.exit(1);
});
