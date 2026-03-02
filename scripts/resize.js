document.addEventListener('DOMContentLoaded', () => {
    const resizeHandle = document.getElementById('resize-handle');
    const body = document.body;

    let isResizing = false;

    resizeHandle.addEventListener('mousedown', (e) => {
        isResizing = true;
        let startX = e.clientX;
        let startY = e.clientY;
        let startWidth = parseInt(document.defaultView.getComputedStyle(body).width, 10);
        let startHeight = parseInt(document.defaultView.getComputedStyle(body).height, 10);

        function doDrag(e) {
            if (isResizing) {
                body.style.width = (startWidth + e.clientX - startX) + 'px';
                body.style.height = (startHeight + e.clientY - startY) + 'px';
            }
        }

        function stopDrag() {
            isResizing = false;
            window.removeEventListener('mousemove', doDrag);
            window.removeEventListener('mouseup', stopDrag);
        }

        window.addEventListener('mousemove', doDrag);
        window.addEventListener('mouseup', stopDrag);
    });
});
