import {
  acceptInvite,
  getUser,
  login,
  logout,
  onAuthChange,
  recoverPassword,
} from "@netlify/identity";

const localMode = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
const loginForm = document.getElementById("login-form");
const inviteForm = document.getElementById("invite-form");
const recoveryForm = document.getElementById("recovery-form");
const loginMessage = document.getElementById("login-message");
let inviteToken = "";
let recoveryToken = "";

function message(text, bad = false) {
  loginMessage.textContent = text;
  loginMessage.classList.toggle("bad", bad);
}

function showAuthFlow() {
  loginForm.hidden = Boolean(inviteToken || recoveryToken);
  inviteForm.hidden = !inviteToken;
  recoveryForm.hidden = !recoveryToken;
  if (inviteToken) message("Set a password to accept your private dashboard invitation.");
  else if (recoveryToken) message("Choose a new password for your account.");
}

function applyUser(user) {
  window.appUser = user;
  window.setSignedIn(user);
}

window.signIn = () => {
  document.getElementById("auth-gate").scrollIntoView({ behavior: "smooth", block: "center" });
  document.querySelector("#login-form input")?.focus();
};

window.signOut = async () => {
  try {
    await logout();
    applyUser(null);
    message("You have signed out.");
  } catch {
    message("Could not sign out. Please refresh and try again.", true);
  }
};

loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = loginForm.querySelector("button[type=submit]");
  button.disabled = true;
  message("Signing in…");
  try {
    const user = await login(document.getElementById("login-email").value.trim(), document.getElementById("login-password").value);
    document.getElementById("login-password").value = "";
    applyUser(user);
    message("");
  } catch (error) {
    message(error?.message || "Sign-in failed. Check your email and password, and make sure the site owner invited you.", true);
  } finally {
    button.disabled = false;
  }
});

inviteForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = inviteForm.querySelector("button[type=submit]");
  button.disabled = true;
  message("Accepting invitation…");
  try {
    const password = document.getElementById("invite-password").value;
    if (password.length < 8) throw new Error("Choose a password with at least 8 characters.");
    const user = await acceptInvite(inviteToken, password);
    history.replaceState(null, "", location.pathname + location.search);
    inviteToken = "";
    document.getElementById("invite-password").value = "";
    applyUser(user);
    showAuthFlow();
  } catch (error) {
    message(error?.message || "Could not accept this invitation. Ask the site owner to send a new invite.", true);
  } finally {
    button.disabled = false;
  }
});

recoveryForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = recoveryForm.querySelector("button[type=submit]");
  button.disabled = true;
  message("Updating password…");
  try {
    const password = document.getElementById("recovery-password").value;
    if (password.length < 8) throw new Error("Choose a password with at least 8 characters.");
    const user = await recoverPassword(recoveryToken, password);
    history.replaceState(null, "", location.pathname + location.search);
    recoveryToken = "";
    document.getElementById("recovery-password").value = "";
    applyUser(user);
    showAuthFlow();
  } catch (error) {
    message(error?.message || "Could not reset the password. Request a new recovery email.", true);
  } finally {
    button.disabled = false;
  }
});

if (localMode) {
  applyUser({ local: true });
} else {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  inviteToken = params.get("invite_token") || "";
  recoveryToken = params.get("recovery_token") || "";
  showAuthFlow();
  document.getElementById("sign-in-button").hidden = Boolean(inviteToken || recoveryToken);
  applyUser(await getUser());
  onAuthChange((_event, user) => applyUser(user));
  if (!window.appUser && !inviteToken && !recoveryToken) message("This dashboard is private. Use the invite email from the site owner to sign in.");
}

