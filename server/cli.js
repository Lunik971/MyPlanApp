// Gestion des comptes en ligne de commande :
//   node server/cli.js add <identifiant> <mot de passe>
//   node server/cli.js passwd <identifiant> <nouveau mot de passe>
//   node server/cli.js list
//   node server/cli.js remove <identifiant>
import { db } from './db.js';
import { createUser, hashPassword } from './auth.js';

const [cmd, user, pass] = process.argv.slice(2);
try {
  if (cmd === 'add' && user && pass) {
    if (pass.length < 8) throw new Error('Mot de passe : 8 caractères minimum');
    createUser(user, pass);
    console.log(`Compte « ${user} » créé.`);
  } else if (cmd === 'passwd' && user && pass) {
    if (pass.length < 8) throw new Error('Mot de passe : 8 caractères minimum');
    const r = db.prepare('UPDATE users SET pass_hash = ? WHERE username = ?').run(hashPassword(pass), user);
    if (!r.changes) throw new Error('Compte introuvable');
    db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)').run(user);
    console.log('Mot de passe modifié, sessions fermées.');
  } else if (cmd === 'list') {
    for (const u of db.prepare('SELECT username, created_at FROM users ORDER BY id').all()) {
      console.log(`${u.username}\t${new Date(u.created_at).toISOString()}`);
    }
  } else if (cmd === 'remove' && user) {
    const r = db.prepare('DELETE FROM users WHERE username = ?').run(user);
    console.log(r.changes ? 'Compte supprimé (ses plans aussi).' : 'Compte introuvable');
  } else {
    console.log('Usage : add|passwd <identifiant> <mot de passe> · list · remove <identifiant>');
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e.message.includes('UNIQUE') ? 'Identifiant déjà utilisé' : e.message);
  process.exitCode = 1;
}
