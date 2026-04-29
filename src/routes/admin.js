import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticate, requirePermission, hasPermission } from '../middleware/auth.js';
import { sanitize, hashPassword, isValidEmail } from '../services/auth.js';

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════════
// PERMISOS
// ═══════════════════════════════════════════════════════════════════════════

// GET /auth/permissions - Listar todos los permisos (agrupados por módulo)
router.get('/permissions', authenticate, requirePermission('users.read'), async (req, res, next) => {
  try {
    const permissions = await prisma.permission.findMany({
      orderBy: [{ module: 'asc' }, { code: 'asc' }],
    });

    // Agrupar por módulo
    const grouped = {};
    for (const perm of permissions) {
      if (!grouped[perm.module]) {
        grouped[perm.module] = [];
      }
      grouped[perm.module].push(perm);
    }

    res.json({ permissions, grouped });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ROLES
// ═══════════════════════════════════════════════════════════════════════════

// GET /auth/roles - Listar todos los roles con sus permisos
router.get('/roles', authenticate, requirePermission('users.read'), async (req, res, next) => {
  try {
    const roles = await prisma.role.findMany({
      orderBy: { name: 'asc' },
      include: {
        permissions: {
          include: {
            permission: { select: { id: true, code: true, name: true, module: true } },
          },
        },
        _count: {
          select: { users: true },
        },
      },
    });

    res.json(roles);
  } catch (err) {
    next(err);
  }
});

// POST /auth/roles - Crear rol (requiere permiso users.create)
router.post('/roles', authenticate, requirePermission('users.create'), async (req, res, next) => {
  try {
    const { name, description, permissionIds } = req.body;

    if (!name || name.trim().length < 2) {
      return res.status(400).json({ error: 'Nombre del rol requerido (mínimo 2 caracteres)', field: 'name' });
    }

    const sanitizedName = sanitize(name).toLowerCase().replace(/\s+/g, '_');

    const existing = await prisma.role.findUnique({ where: { name: sanitizedName } });
    if (existing) {
      return res.status(409).json({ error: 'Ya existe un rol con ese nombre', field: 'name' });
    }

    const role = await prisma.role.create({
      data: {
        name: sanitizedName,
        description: description ? sanitize(description) : null,
        ...(permissionIds && permissionIds.length > 0 ? {
          permissions: {
            create: permissionIds.map(id => ({
              permissionId: parseInt(id),
            })),
          },
        } : {}),
      },
      include: {
        permissions: { include: { permission: true } },
      },
    });

    res.status(201).json({
      message: 'Rol creado exitosamente',
      role,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /auth/roles/:id - Actualizar rol (requiere permiso users.edit)
router.put('/roles/:id', authenticate, requirePermission('users.edit'), async (req, res, next) => {
  try {
    const roleId = parseInt(req.params.id);
    const { name, description, permissionIds } = req.body;

    const role = await prisma.role.findUnique({ where: { id: roleId } });
    if (!role) {
      return res.status(404).json({ error: 'Rol no encontrado' });
    }

    const updateData = {};

    if (name !== undefined) {
      const sanitizedName = sanitize(name).toLowerCase().replace(/\s+/g, '_');
      const duplicate = await prisma.role.findFirst({
        where: { name: sanitizedName, id: { not: roleId } },
      });
      if (duplicate) {
        return res.status(409).json({ error: 'Ya existe un rol con ese nombre' });
      }
      updateData.name = sanitizedName;
    }

    if (description !== undefined) {
      updateData.description = sanitize(description) || null;
    }

    if (permissionIds !== undefined) {
      // Reemplazar todos los permisos del rol
      await prisma.rolePermission.deleteMany({ where: { roleId } });
      if (permissionIds.length > 0) {
        await prisma.rolePermission.createMany({
          data: permissionIds.map(id => ({
            roleId,
            permissionId: parseInt(id),
          })),
        });
      }
    }

    const updated = await prisma.role.update({
      where: { id: roleId },
      data: updateData,
      include: {
        permissions: { include: { permission: true } },
        _count: { select: { users: true } },
      },
    });

    res.json({
      message: 'Rol actualizado',
      role: updated,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /auth/roles/:id - Eliminar rol (soft delete)
router.delete('/roles/:id', authenticate, requirePermission('users.delete'), async (req, res, next) => {
  try {
    const roleId = parseInt(req.params.id);

    const role = await prisma.role.findUnique({
      where: { id: roleId },
      include: { _count: { select: { users: true } } },
    });

    if (!role) {
      return res.status(404).json({ error: 'Rol no encontrado' });
    }

    if (role._count.users > 0) {
      return res.status(409).json({
        error: `No se puede eliminar el rol porque tiene ${role._count.users} usuario(s) asignado(s)`,
      });
    }

    await prisma.role.update({
      where: { id: roleId },
      data: {
        deletedAt: new Date(),
        deletedBy: req.user.id,
        active: false,
      },
    });

    res.json({ message: 'Rol eliminado correctamente' });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// USUARIOS - Gestión de roles y permisos directos
// ═══════════════════════════════════════════════════════════════════════════

// GET /auth/users - Listar usuarios con sus roles (requiere permiso users.read)
router.get('/users', authenticate, requirePermission('users.read'), async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit),
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          active: true,
          emailVerified: true,
          createdAt: true,
          stores: {
            include: {
              store: { select: { id: true, name: true } },
            },
          },
          roles: {
            include: {
              role: { select: { id: true, name: true, description: true } },
            },
          },
          permissions: {
            include: {
              permission: { select: { id: true, code: true, name: true, module: true } },
            },
          },
          _count: { select: { orders: true } },
        },
      }),
      prisma.user.count(),
    ]);

    const formatted = users.map(u => ({
      ...u,
      stores: u.stores.map(us => us.store),
      roles: u.roles.map(ur => ur.role),
      permissions: u.permissions.map(up => up.permission),
    }));

    res.json({
      data: formatted,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
});

// PUT /auth/users/:id/roles - Asignar roles a un usuario (requiere permiso users.edit)
router.put('/users/:id/roles', authenticate, requirePermission('users.edit'), async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const { roleIds } = req.body;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (!roleIds || !Array.isArray(roleIds)) {
      return res.status(400).json({ error: 'Lista de roleIds requerida' });
    }

    // Verificar que todos los roles existen
    const roles = await prisma.role.findMany({
      where: { id: { in: roleIds.map(id => parseInt(id)) } },
    });

    if (roles.length !== roleIds.length) {
      return res.status(400).json({ error: 'Uno o más roles no encontrados' });
    }

    // Reemplazar roles del usuario
    await prisma.userRole.deleteMany({ where: { userId } });
    await prisma.userRole.createMany({
      data: roles.map(role => ({
        userId,
        roleId: role.id,
      })),
    });

    res.json({ message: 'Roles actualizados correctamente' });
  } catch (err) {
    next(err);
  }
});

// POST /auth/users/:id/permissions - Asignar permiso directo a usuario (requiere permiso users.edit)
router.post('/users/:id/permissions', authenticate, requirePermission('users.edit'), async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const { permissionId } = req.body;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (!permissionId) {
      return res.status(400).json({ error: 'permissionId requerido' });
    }

    const permission = await prisma.permission.findUnique({
      where: { id: parseInt(permissionId) },
    });

    if (!permission) {
      return res.status(404).json({ error: 'Permiso no encontrado' });
    }

    await prisma.userPermission.create({
      data: {
        userId,
        permissionId: parseInt(permissionId),
      },
    });

    res.json({ message: 'Permiso asignado al usuario' });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'El usuario ya tiene este permiso asignado' });
    }
    next(err);
  }
});

// PUT /auth/users/:id - Editar datos de un usuario (admin)
router.put('/users/:id', authenticate, requirePermission('users.edit'), async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const { name, phone, birthdate, active, storeIds } = req.body;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const updateData = {};

    if (name !== undefined) {
      const sanitizedName = sanitize(name);
      if (sanitizedName.length < 2) {
        return res.status(400).json({ error: 'El nombre debe tener al menos 2 caracteres', field: 'name' });
      }
      updateData.name = sanitizedName;
    }

    if (phone !== undefined) {
      updateData.phone = sanitize(phone) || null;
    }

    if (birthdate !== undefined) {
      updateData.birthdate = sanitize(birthdate) || null;
    }

    if (active !== undefined) {
      updateData.active = Boolean(active);
    }

    // Actualizar tiendas asignadas (muchos a muchos)
    if (storeIds !== undefined) {
      if (Array.isArray(storeIds) && storeIds.length > 0) {
        const stores = await prisma.store.findMany({
          where: { id: { in: storeIds.map(id => parseInt(id)) } },
        });
        if (stores.length !== storeIds.length) {
          return res.status(400).json({ error: 'Una o más tiendas no encontradas', field: 'storeIds' });
        }
      }
      // Reemplazar todas las asignaciones de tiendas
      await prisma.userStore.deleteMany({ where: { userId } });
      if (Array.isArray(storeIds) && storeIds.length > 0) {
        await prisma.userStore.createMany({
          data: storeIds.map(id => ({
            userId,
            storeId: parseInt(id),
          })),
        });
      }
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        birthdate: true,
        active: true,
        createdAt: true,
        stores: {
          include: { store: { select: { id: true, name: true } } },
        },
      },
    });

    res.json({
      message: 'Usuario actualizado correctamente',
      user: {
        ...updated,
        stores: updated.stores.map(us => us.store),
      },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /auth/users/:id/permissions/:permissionId - Revocar permiso directo
router.delete('/users/:id/permissions/:permissionId', authenticate, requirePermission('users.edit'), async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const permissionId = parseInt(req.params.permissionId);

    await prisma.userPermission.deleteMany({
      where: { userId, permissionId },
    });

    res.json({ message: 'Permiso revocado del usuario' });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// CREAR USUARIO (ADMIN)
// ═══════════════════════════════════════════════════════════════════════════

// POST /auth/users - Crear usuario desde admin
router.post('/users', authenticate, requirePermission('users.create'), async (req, res, next) => {
  try {
    const { name, email, password, phone, birthdate, roleIds, storeIds } = req.body;

    if (!name || name.trim().length < 2) {
      return res.status(400).json({ error: 'Nombre requerido (mínimo 2 caracteres)', field: 'name' });
    }
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Email válido requerido', field: 'email' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Contraseña requerida (mínimo 6 caracteres)', field: 'password' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (existingUser) {
      return res.status(409).json({ error: 'Ya existe un usuario con ese email', field: 'email' });
    }

    const hashedPassword = await hashPassword(password);

    // Validar roles si se proporcionan
    let rolesData = [];
    if (roleIds && Array.isArray(roleIds) && roleIds.length > 0) {
      const roles = await prisma.role.findMany({
        where: { id: { in: roleIds.map(id => parseInt(id)) } },
      });
      if (roles.length !== roleIds.length) {
        return res.status(400).json({ error: 'Uno o más roles no encontrados' });
      }
      rolesData = roles;
    } else {
      // Si no se especifican roles, asignar customer por defecto
      const customerRole = await prisma.role.findUnique({ where: { name: 'customer' } });
      if (customerRole) rolesData = [customerRole];
    }

    // Validar storeIds si se proporcionan
    let storeData = [];
    if (storeIds && Array.isArray(storeIds) && storeIds.length > 0) {
      const stores = await prisma.store.findMany({
        where: { id: { in: storeIds.map(id => parseInt(id)) } },
      });
      if (stores.length !== storeIds.length) {
        return res.status(400).json({ error: 'Una o más tiendas no encontradas', field: 'storeIds' });
      }
      storeData = stores;
    }

    const user = await prisma.user.create({
      data: {
        name: sanitize(name),
        email: email.toLowerCase().trim(),
        password: hashedPassword,
        phone: phone ? sanitize(phone) : null,
        birthdate: birthdate ? sanitize(birthdate) : null,
        active: true,
        emailVerified: new Date(),
        roles: {
          create: rolesData.map(role => ({
            roleId: role.id,
          })),
        },
        stores: {
          create: storeData.map(store => ({
            storeId: store.id,
          })),
        },
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        active: true,
        createdAt: true,
        roles: {
          include: {
            role: { select: { id: true, name: true, description: true } },
          },
        },
        stores: {
          include: { store: { select: { id: true, name: true } } },
        },
      },
    });

    res.status(201).json({
      message: 'Usuario creado exitosamente',
      user: {
        ...user,
        roles: user.roles.map(ur => ur.role),
        stores: user.stores.map(us => us.store),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
