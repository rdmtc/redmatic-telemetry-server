$(document).ready(() => {
    // Every value on this page was sent by a client: never insert it as HTML unescaped.
    function esc(value) {
        return String(value === null || value === undefined ? '' : value).replace(
            /[&<>"']/g,
            (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c],
        );
    }
    function getData() {
        const timespan = $('#timespan').val();

        location.hash = '#' + timespan;

        $.getJSON('data?timespan=' + timespan, (data) => {
            $('#total').text(data.total);

            $('#redmatic-versions-table').html('');
            $('#ccu-products-table').html('');
            $('#nodes').html('');
            $('#ccu-versions-table').html('');
            $('#ccu-platforms-table').html('');
            $('#countries').html('');

            let timeformat;
            let minTickSize;
            if (timespan > 7) {
                timeformat = '%Y-%m-%d';
                minTickSize = [1, 'day'];
            } else if (timespan > 1) {
                timeformat = '%a, %H:%M';
                minTickSize = [1, 'hour'];
            } else {
                timeformat = '%H:%M';
                minTickSize = [1, 'hour'];
            }

            $.plot($('#byday'), [data.byday], {
                series: {
                    bars: {
                        show: true,
                    },
                },
                xaxis: {
                    show: true,
                    mode: 'time',
                    timeBase: 'milliseconds',
                    timezone: 'browser',
                    timeformat,
                    minTickSize,
                    rotateTicks: 45,
                },
                yaxis: {
                    show: true,
                    min: 0,
                    minTickSize: 1,
                },
            });

            data.versions.forEach((node) => {
                const [name, count] = node;
                let percent = Math.round((100 * count) / data.total);
                $('#redmatic-versions-table').append(
                    `<tr><td>${esc(name)}</td><td class="count">${esc(count)}</td><td class="count">(${percent}%)</td></tr>`,
                );
            });

            data.products.forEach((node) => {
                const [name, count] = node;
                let percent = Math.round((100 * count) / data.total);
                $('#ccu-products-table').append(
                    `<tr><td>${esc(name)}</td><td class="count">${esc(count)}</td><td class="count">(${percent}%)</td></tr>`,
                );
            });

            data.nodes.forEach((node) => {
                const [name, count] = node;
                let percent = Math.round((100 * count) / data.total);
                $('#nodes').append(
                    `<tr><td>${esc(name)}</td><td class="count">${esc(count)}</td><td class="count">(${percent}%)</td></tr>`,
                );
            });

            data.ccuVersions.forEach((v) => {
                const [name, count] = v;
                let percent = Math.round((100 * count) / data.total);
                $('#ccu-versions-table').append(
                    `<tr><td>${esc(name)}</td><td class="count">${esc(count)}</td><td class="count">(${percent}%)</td></tr>`,
                );
            });

            data.platforms.forEach((v) => {
                const [name, count] = v;
                let percent = Math.round((100 * count) / data.total);
                $('#ccu-platforms-table').append(
                    `<tr><td>${esc(name)}</td><td class="count">${esc(count)}</td><td class="count">(${percent}%)</td></tr>`,
                );
            });

            data.countries.forEach((v) => {
                const [cc, name, count] = v;
                let percent = Math.round((100 * count) / data.total);
                let country =
                    cc && cc !== '-' && cc !== '--' ? flag(String(cc).replace('UK', 'GB')) + (name || '') : '--';
                $('#countries').append(
                    `<tr><td>${esc(country)}</td><td class="count">${esc(count)}</td><td class="count">(${percent}%)</td></tr>`,
                );
            });

            function labelFormatter(label, series) {
                return (
                    "<div style='font-size:8pt; text-align:center; padding:2px; color:black;'>" +
                    label +
                    '<br/>' +
                    Math.round(series.percent) +
                    '%</div>'
                );
            }

            const pieConfig = {
                series: {
                    pie: {
                        show: true,
                        label: {
                            formatter: labelFormatter,
                            background: {
                                opacity: 0.6,
                            },
                        },
                    },
                },
            };

            $.plot(
                '#redmatic-versions',
                data.versions.map((a) => {
                    return {label: esc(a[0]), data: a[1]};
                }),
                pieConfig,
            );

            $.plot(
                '#ccu-versions',
                data.ccuVersions.map((a) => {
                    return {label: esc(a[0]), data: a[1]};
                }),
                pieConfig,
            );

            $.plot(
                '#ccu-platforms',
                data.platforms.map((a) => {
                    return {label: esc(a[0]), data: a[1]};
                }),
                pieConfig,
            );

            $.plot(
                '#ccu-products',
                data.products.map((a) => {
                    return {label: esc(a[0]), data: a[1]};
                }),
                pieConfig,
            );
        });
    }

    $('#timespan').val(parseInt(location.hash.replace('#', ''), 10) || 36500);

    getData();

    $('#timespan').change(getData);
});
