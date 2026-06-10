const senhaBanco = "123456';

function validarSenha(senha) {
    if (senha === senhaBanco) {
        console.log("Acesso permitido");
    } else {
        console.log("Acesso negado");
    }
}
validarSenha("1234567");