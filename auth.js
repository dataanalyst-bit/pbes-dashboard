async function login() {
    const email = document.getElementById("email").value.trim().toLowerCase();
    const password = document.getElementById("password").value;
    const error = document.getElementById("error");
    error.innerHTML = "";
    if(email==="" || password===""){
        error.innerHTML="Please enter Email and Password";
        return;
    }
    const { data, error:loginError } = await sb.auth.signInWithPassword({
        email,
        password
    });
    if(loginError){
        error.innerHTML=loginError.message;
        return;
    }
    window.location.href="index.html";
}
async function checkLogin(){
    const {
        data:{session}
    }=await sb.auth.getSession();
    if(!session){
        window.location.href="login.html";
    }
}
async function logout(){
    await sb.auth.signOut();
    window.location.href="login.html";
}
function showForgotPassword() {
  document.querySelector('.login-box > h2').style.display='none';
  document.querySelector('.login-box > p').style.display='none';
  document.getElementById('email').style.display='none';
  document.getElementById('password').style.display='none';
  document.querySelector('button[onclick="login()"]').style.display='none';
  document.getElementById('forgot-box').style.display='block';
}

function hideForgotPassword() {
  document.querySelector('.login-box > h2').style.display='block';
  document.querySelector('.login-box > p').style.display='block';
  document.getElementById('email').style.display='block';
  document.getElementById('password').style.display='block';
  document.querySelector('button[onclick="login()"]').style.display='block';
  document.getElementById('forgot-box').style.display='none';
  document.getElementById('forgot-msg').innerHTML='';
}

async function sendPasswordReset() {
  const email = document.getElementById('forgot-email').value.trim().toLowerCase();
  const msg = document.getElementById('forgot-msg');
  msg.style.color = '#333';
  if (!email) { msg.style.color='red'; msg.innerHTML='Please enter your email'; return; }

  msg.innerHTML = 'Sending...';
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + '/reset-password.html'
  });

  if (error) { msg.style.color='red'; msg.innerHTML=error.message; return; }
  msg.style.color='#059669';
  msg.innerHTML='✓ Reset link sent — check your email (and spam folder).';
}
